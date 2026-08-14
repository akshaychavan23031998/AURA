# Gateway Service

The Gateway is AURA's external HTTP and WebSocket entry point. Phase 16 adds Google OIDC account entry while preserving AURA-owned users, sessions, tokens, permissions, and voice transport.

## Implemented

- Fastify lifecycle, validated immutable configuration, structured/redacted logging, request correlation, Helmet headers, stable errors, and graceful shutdown
- liveness plus PostgreSQL-backed readiness
- trusted Agent and Tool Service clients and deterministic single-tool orchestration
- strict HS256 bearer verification with issuer, audience, lifetime, persisted user `sub`, session `sid`, version, and permission validation
- Drizzle-managed PostgreSQL users, sessions, and refresh-token history
- immediate active-session and active-user enforcement on protected requests
- transactional refresh rotation, replay-family revocation, and idempotent logout
- browser refresh-cookie transport with exact-Origin CSRF checks and narrowly scoped credentialed CORS
- Google OpenID Connect Authorization Code + PKCE with encrypted transient state and durable subject binding
- idempotent development-user bootstrap and development-session CLIs
- authenticated `aura.voice.v1` WebSocket sessions with fixed PCM framing, server-side energy VAD, explicit turn states, correlation, heartbeat/idle cleanup, and chunked completed-WAV output

## Endpoints

| Method | Path                               | Authentication      | Purpose                                          |
| ------ | ---------------------------------- | ------------------- | ------------------------------------------------ |
| `GET`  | `/health`                          | None                | Process liveness                                 |
| `GET`  | `/ready`                           | None                | Gateway and PostgreSQL readiness                 |
| `POST` | `/api/v1/auth/refresh`             | Refresh cookie/body | Rotate refresh token and issue access token      |
| `POST` | `/api/v1/auth/logout`              | Bearer              | Revoke the caller's current session              |
| `POST` | `/api/v1/auth/development-session` | Development only    | Create the fixed local development identity      |
| `GET`  | `/api/v1/auth/google/start`        | None                | Start Google OIDC with state, nonce, and PKCE    |
| `GET`  | `/api/v1/auth/google/callback`     | Transaction cookie  | Validate Google identity and create AURA session |
| `POST` | `/api/v1/tools/execute`            | Bearer              | Execute a validated Tool Service request         |
| `POST` | `/api/v1/agent/respond`            | Bearer              | Produce an unexecuted planning response          |
| `POST` | `/api/v1/agent/run`                | Bearer              | Run deterministic orchestration                  |
| `POST` | `/api/v1/voice/run`                | Bearer              | Run one multipart voice turn                     |
| `GET`  | `/api/v1/voice/session`            | Bearer upgrade      | Open an `aura.voice.v1` WebSocket session        |

Operational endpoints remain unversioned; application APIs use `/api/v1`.

## Configuration

The service-local `.env.example` is the executable Gateway contract; the root example remains a workspace overview.

| Variable                            | Default                 | Constraint                             |
| ----------------------------------- | ----------------------- | -------------------------------------- |
| `NODE_ENV`                          | `development`           | `development`, `test`, or `production` |
| `GATEWAY_HOST`                      | `0.0.0.0`               | non-empty host                         |
| `GATEWAY_PORT`                      | `4000`                  | 1-65535                                |
| `GATEWAY_TRUST_PROXY`               | loopback addresses      | explicit proxy IPs/CIDRs; never `*`    |
| `LOG_LEVEL`                         | `info`                  | supported Pino level                   |
| `TOOLS_SERVICE_URL`                 | `http://localhost:4001` | trusted HTTP/HTTPS URL                 |
| `TOOLS_SERVICE_TOKEN`               | none                    | required, 32+ characters               |
| `TOOLS_SERVICE_TIMEOUT_MS`          | `3000`                  | 100-30000 ms                           |
| `AGENT_SERVICE_URL`                 | `http://localhost:8001` | trusted HTTP/HTTPS URL                 |
| `AGENT_SERVICE_TOKEN`               | none                    | required, 32+ characters               |
| `AGENT_SERVICE_TIMEOUT_MS`          | `5000`                  | 100-300000 ms; increase for local LLM  |
| `AUTH_JWT_SECRET`                   | none                    | required, 32-512 characters            |
| `AUTH_JWT_ISSUER`                   | `aura-gateway`          | non-empty, at most 128 characters      |
| `AUTH_JWT_AUDIENCE`                 | `aura-api`              | non-empty, at most 128 characters      |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`     | `900`                   | 60-3600 seconds                        |
| `AUTH_SESSION_TTL_SECONDS`          | `604800`                | 3600-2592000 seconds                   |
| `WEB_APP_ORIGIN`                    | `http://localhost:3000` | exact trusted browser origin           |
| `GOOGLE_OIDC_ENABLED`               | `false`                 | enables both Google routes             |
| `GOOGLE_OIDC_CLIENT_ID`             | none                    | required when enabled                  |
| `GOOGLE_OIDC_CLIENT_SECRET`         | none                    | required when enabled; never logged    |
| `GOOGLE_OIDC_REDIRECT_URI`          | none                    | exact registered callback URI          |
| `DATABASE_URL`                      | none                    | required PostgreSQL URL                |
| `DATABASE_POOL_MAX`                 | `10`                    | bounded pool size, 1-50                |
| `DATABASE_CONNECT_TIMEOUT_MS`       | `3000`                  | connection acquisition timeout         |
| `DATABASE_QUERY_TIMEOUT_MS`         | `5000`                  | PostgreSQL query timeout               |
| `VOICE_STREAM_MAX_FRAME_BYTES`      | `640`                   | maximum inbound binary frame           |
| `VOICE_VAD_THRESHOLD`               | `500`                   | absolute PCM energy threshold          |
| `VOICE_VAD_MIN_SPEECH_MS`           | `100`                   | speech-start debounce                  |
| `VOICE_VAD_END_SILENCE_MS`          | `600`                   | utterance-end silence                  |
| `VOICE_SESSION_IDLE_TIMEOUT_MS`     | `120000`                | inactive session lifetime              |
| `VOICE_BARGE_IN_ENABLED`            | `true`                  | enable validated-speech interruption   |
| `VOICE_BARGE_IN_MIN_SPEECH_MS`      | `100`                   | speech required before interruption    |
| `VOICE_INTERRUPT_SETTLE_TIMEOUT_MS` | `5000`                  | cancellation settlement warning bound  |

Configuration is read once and fails fast. Database connection and query timeouts are bounded. URLs, tokens, hashes, secrets, cookies, authorization headers, and request bodies are not logged.

Production requires an HTTPS `WEB_APP_ORIGIN` and, when enabled, an HTTPS Google callback. `GATEWAY_TRUST_PROXY` must name only reverse-proxy addresses or CIDRs that can directly reach Gateway. Fastify ignores forwarded client addresses from all other peers. The supplied Compose network fixes Caddy and Gateway inside `172.28.0.0/24`; Gateway is not host-published.

Run migrations explicitly before Gateway rollout with `pnpm db:migrate` from source or `node dist/db/migrate.js` in the production image. Gateway readiness checks PostgreSQL but never mutates schema. Pool size and connect/query deadlines are bounded through configuration.

## Local identity flow

PostgreSQL is required. The focused Compose file runs PostgreSQL only:

```powershell
$env:POSTGRES_PASSWORD = "replace-with-local-password"
docker compose -f infrastructure/docker/postgres.compose.yml up -d
pnpm.cmd db:migrate
$userId = pnpm.cmd identity:bootstrap-dev-user
$env:AUTH_JWT_SECRET = "replace-with-at-least-32-characters"
pnpm.cmd identity:dev-session -- --user-id $userId
```

The final command deliberately prints development-only tokens to the local terminal. It never writes them to repository files or structured logs. Gateway startup never seeds identities.

For validation, set `TEST_DATABASE_URL` to a separate database whose name ends in `_test` or `_tests`, then run:

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
```

The persistence suite deliberately rebuilds only that test database's `public` schema, applies fresh migrations, and does not silently skip when the variable is absent.

## Identity and session security

Access JWTs are short lived. Their `sub` identifies a persisted user and `sid` identifies a persisted session. After cryptographic verification, every protected request checks that the session is unexpired and unrevoked and that the user remains `ACTIVE`. Logout, revocation, and user disable therefore take effect immediately. One PostgreSQL lookup per protected request is an intentional Phase 8 security tradeoff; a future Redis cache may optimize it, but Redis is not implemented.

Refresh tokens contain 32 cryptographically random bytes encoded as base64url. Only SHA-256 digests are stored because high-entropy opaque tokens do not need password hashing. Rotation locks and consumes the current record transactionally, stores a replacement, and preserves absolute session expiry. Reuse of consumed/revoked evidence returns the same generic 401 as other authentication failures and revokes the whole session family. Raw tokens and hashes never enter application logs.

For browsers, `/refresh` reads and rotates `aura_refresh` from an HttpOnly cookie and returns only the short-lived access token. The replacement cookie is `SameSite=Strict`, scoped to `/api/v1/auth`, and `Secure` in production. Cookie-backed refresh/logout requests must carry the exact configured `WEB_APP_ORIGIN`; credentialed CORS is restricted to that same origin. The legacy `{ "refreshToken": "..." }` request and access/refresh response remain available for non-browser development tooling and compatibility.

`/logout` requires a current access token, revokes its persisted session, clears the browser cookie, and returns 204. `/development-session` exists only when Gateway runs with `NODE_ENV=development`; it accepts no user or permission selection and always bootstraps the repository's fixed development identity. Production responds with 404. There are no password, signup, or public user-selection endpoints.

## Google OIDC

Gateway uses the OpenID-certified `openid-client` v6 library for Google discovery, code exchange, and OIDC validation. Identity-only deployments request `openid email profile`. Calendar and Gmail scopes/offline access are added only when their explicit feature flags are enabled; Drive and unrelated permissions are never requested.

The OAuth transaction is AES-256-GCM encrypted into a ten-minute `HttpOnly`, `SameSite=Lax` callback-scoped cookie. `Lax` permits Google's top-level cross-site redirect; the AURA refresh cookie remains `SameSite=Strict`. Callback redirects are built solely from `WEB_APP_ORIGIN`, never `returnTo`. Success creates a new persisted AURA session and refresh cookie, while provider tokens are discarded.

The `external_identities` table uniquely keys `google + sub`. Existing subjects reuse the same AURA user; new subjects create one ACTIVE user and binding atomically. Verified email can be retained as link-time metadata but email never links accounts.

Google Cloud Console setup:

1. Configure the OAuth consent/branding screen with the AURA name, support contact, and only `openid`, `email`, and `profile` identity scopes.
2. Create an OAuth client of type **Web application**.
3. Register the exact redirect URI, locally `http://localhost:4000/api/v1/auth/google/callback`.
4. Set `GOOGLE_OIDC_ENABLED=true`, the issued client ID and secret, the exact redirect URI, and `WEB_APP_ORIGIN` locally. Use HTTPS for production origins and callbacks.

The fixed Phase 8 permission is `system.echo`; persistent RBAC is not implemented. Identity persistence establishes who the caller is and whether the session is active. Tool Service remains authoritative for tool-specific permission, risk, approval, and execution policy. External JWTs are never forwarded to Agent or Tool Service.

## Boundaries

The Gateway owns HTTP ingress, identity/session persistence, request lifecycle, external errors, correlation, edge hardening, trusted downstream calls, and orchestration. It does not own LLM inference, audio processing, retrieval, tool execution, external integrations, Kafka analytics, or Agent/Tool database access. Passwords, additional providers, RBAC expansion, rate limiting, Redis, and Kubernetes remain future milestones.

## Turn-based voice API

`POST /api/v1/voice/run` requires the same persisted bearer session as Agent routes. It accepts multipart `audio` (16 kHz mono 16-bit PCM WAV, at most 10 MiB/30 seconds), optional `conversationId`, and optional locale hint. Gateway calls Voice STT, runs the transcript through the existing `AgentToolOrchestrator`, calls Voice TTS once, and returns bounded JSON with `transcript`, `detectedLanguage`, `responseText`, `audioBase64`, and `audioMimeType`.

Gateway uses a distinct `VOICE_SERVICE_TOKEN` and propagates `x-request-id` to STT and TTS. Uploaded audio and text are not logged. If synthesis fails after an action, Gateway reports that the action may have completed and never repeats Agent/Tool execution. This endpoint is a turn-based foundation; no streaming transport is implemented.

The internal TTS request uses a normalized locale. Current capability is English and Hindi supported, Hinglish/Telugu experimental, and Kannada explicitly unsupported. Gateway does not select model paths or expose internal voice identifiers.

## Realtime voice session

Non-browser clients connect to `GET /api/v1/voice/session` with the normal bearer credential. Browser clients offer `aura.voice.v1` and `aura.jwt.<access-token>` WebSocket subprotocols; Gateway negotiates only `aura.voice.v1`, redacts the credential header, and invokes the existing JWT/session verifier. After connecting, send `{"protocol":"aura.voice.v1","type":"session.start"}`, then binary 20 ms frames of 16 kHz, mono, signed 16-bit little-endian PCM (exactly 640 bytes).

The normal state path is `CONNECTED → READY → LISTENING → PROCESSING → SPEAKING → READY`; validated barge-in adds `INTERRUPTING`, and `CLOSED` is terminal. During processing/speaking, frames are analyzed only for bounded authoritative barge-in. Invalid or oversized frames, utterances, buffers, and idle sessions fail closed without orchestration retries. Audio/text content is not logged. Request IDs are rooted in the upgrade request and each turn derives a correlated child ID.

Current VAD is a deterministic in-process PCM energy detector. It is dependency-light and testable, but less robust than neural VAD in noise. STT and TTS remain whole-turn Voice Service calls; completed WAV bytes are chunked only for transport. Partial transcripts, native browser capture, streamed STT/TTS, multi-turn persistence, and Redis coordination are not implemented.

### Barge-in and safe cancellation

During `PROCESSING` or `SPEAKING`, inbound PCM continues through a separate VAD. Sustained speech emits `turn.interrupting`, `turn.interrupted`, and `turn.superseded`, then begins one bounded replacement turn. Noise or speech shorter than `VOICE_BARGE_IN_MIN_SPEECH_MS` has no effect. Unsent old WAV chunks stop at the next cooperative chunk boundary.

| Execution phase    | Interruption behavior                                                |
| ------------------ | -------------------------------------------------------------------- |
| STT                | Abort request; suppress stale output                                 |
| Initial Agent      | Abort request before Tool dispatch                                   |
| Tool execution     | Never abort or retry; buffer replacement audio until terminal result |
| Agent finalization | Abort response generation; retain successful Tool completion         |
| TTS                | Abort request; emit no old audio                                     |
| Audio delivery     | Stop remaining unsent chunks                                         |

Tool dispatch is the action-commit boundary. Interruption never rolls back, replays, or automatically retries an action. A Tool that succeeds after supersession emits only `turn.action_completed_after_interrupt`; no arguments or result data are exposed. A failed or ambiguous Tool call is likewise never retried. Client events are strict and cannot provide actor, permissions, cancellation scope, Tool state, or service identity.

Phase 18 preserves Gateway orchestration ownership: the Agent proposes one namespaced tool and input, while Gateway supplies the authenticated actor and server-derived permissions. Tool Service owns versions and policy; public clients cannot inject identity, permissions, risk, approval, results, or execution state.

Phase 19 adds the exact permissions `utility.calculator` and `utility.datetime` alongside `system.echo`. They use the same authenticated REST and voice orchestration paths; Gateway contains no calculator, timezone, or integration implementation logic.

Phase 20 persists approval requests in PostgreSQL with owner, expiry, exact-action digest, safe preview, terminal decision timestamps, and a bounded trusted Agent continuation envelope. REQUIRED Agent proposals suspend before Tool dispatch. `POST /api/v1/approvals/:id/approve` atomically consumes the record, executes the exact stored action once, and passes the ordinary Tool result through Agent continuation; rejection never invokes Tool Service or Agent. Authenticated approval routes never accept actor, permissions, tool input, version, digest, or approval proof from the browser. Ambiguous Tool Service outcomes are never retried.

Realtime sessions emit `approval.required`, enter `AWAITING_APPROVAL`, and reject microphone frames with `VOICE_APPROVAL_PENDING` until an explicit HTTP decision. Approval resumes Agent-completed text through TTS on the still-connected socket; rejection settles the turn without execution. Disconnect removes only the ephemeral notification listener and never executes or replays the durable approval.

Google Calendar access is opt-in through `GOOGLE_CALENDAR_ENABLED`. Authorization Code + PKCE requests `calendar.readonly` for reads and `calendar.events` for create/update/delete, plus offline access. AURA independently requires exact `calendar.events.read` or `calendar.events.write`; old read-only credentials return `PROVIDER_REAUTH_REQUIRED` before mutation. A 32-byte base64 key protects refresh credentials bound to the stable Google subject. Gateway refreshes bounded access tokens and forwards them only over the internal Tool channel. Every Calendar mutation suspends through exact-action approval; one consumed approval permits at most one dispatch and no ambiguous mutation is retried.

Gmail read access is separately gated by `GOOGLE_GMAIL_ENABLED`. It adds only `gmail.readonly` to Google consent and requires exact AURA permission `gmail.messages.read`. Existing credentials missing that scope fail with `PROVIDER_REAUTH_REQUIRED` before Tool Service is called. The same encrypted provider credential and fixed token endpoint are reused; Gmail tokens remain internal and ephemeral.
