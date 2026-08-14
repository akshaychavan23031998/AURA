# Gateway Service

The Gateway is AURA's external HTTP and WebSocket entry point. Phase 12 adds an authenticated, bounded realtime voice-session transport while reusing the existing STT, Agent/Tool orchestration, and TTS pipeline.

## Implemented

- Fastify lifecycle, validated immutable configuration, structured/redacted logging, request correlation, Helmet headers, stable errors, and graceful shutdown
- liveness plus PostgreSQL-backed readiness
- trusted Agent and Tool Service clients and deterministic single-tool orchestration
- strict HS256 bearer verification with issuer, audience, lifetime, persisted user `sub`, session `sid`, version, and permission validation
- Drizzle-managed PostgreSQL users, sessions, and refresh-token history
- immediate active-session and active-user enforcement on protected requests
- transactional refresh rotation, replay-family revocation, and idempotent logout
- idempotent development-user bootstrap and development-session CLIs
- authenticated `aura.voice.v1` WebSocket sessions with fixed PCM framing, server-side energy VAD, explicit turn states, correlation, heartbeat/idle cleanup, and chunked completed-WAV output

## Endpoints

| Method | Path                    | Authentication | Purpose                                     |
| ------ | ----------------------- | -------------- | ------------------------------------------- |
| `GET`  | `/health`               | None           | Process liveness                            |
| `GET`  | `/ready`                | None           | Gateway and PostgreSQL readiness            |
| `POST` | `/api/v1/auth/refresh`  | Refresh body   | Rotate refresh token and issue access token |
| `POST` | `/api/v1/auth/logout`   | Bearer         | Revoke the caller's current session         |
| `POST` | `/api/v1/tools/execute` | Bearer         | Execute a validated Tool Service request    |
| `POST` | `/api/v1/agent/respond` | Bearer         | Produce an unexecuted planning response     |
| `POST` | `/api/v1/agent/run`     | Bearer         | Run deterministic orchestration             |
| `POST` | `/api/v1/voice/run`     | Bearer         | Run one multipart voice turn                |
| `GET`  | `/api/v1/voice/session` | Bearer upgrade | Open an `aura.voice.v1` WebSocket session   |

Operational endpoints remain unversioned; application APIs use `/api/v1`.

## Configuration

The service-local `.env.example` is the executable Gateway contract; the root example remains a workspace overview.

| Variable                            | Default                 | Constraint                             |
| ----------------------------------- | ----------------------- | -------------------------------------- |
| `NODE_ENV`                          | `development`           | `development`, `test`, or `production` |
| `GATEWAY_HOST`                      | `0.0.0.0`               | non-empty host                         |
| `GATEWAY_PORT`                      | `4000`                  | 1-65535                                |
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
| `DATABASE_URL`                      | none                    | required PostgreSQL URL                |
| `VOICE_STREAM_MAX_FRAME_BYTES`      | `640`                   | maximum inbound binary frame           |
| `VOICE_VAD_THRESHOLD`               | `500`                   | absolute PCM energy threshold          |
| `VOICE_VAD_MIN_SPEECH_MS`           | `100`                   | speech-start debounce                  |
| `VOICE_VAD_END_SILENCE_MS`          | `600`                   | utterance-end silence                  |
| `VOICE_SESSION_IDLE_TIMEOUT_MS`     | `120000`                | inactive session lifetime              |
| `VOICE_BARGE_IN_ENABLED`            | `true`                  | enable validated-speech interruption   |
| `VOICE_BARGE_IN_MIN_SPEECH_MS`      | `100`                   | speech required before interruption    |
| `VOICE_INTERRUPT_SETTLE_TIMEOUT_MS` | `5000`                  | cancellation settlement warning bound  |

Configuration is read once and fails fast. Database connection and query timeouts are bounded. URLs, tokens, hashes, secrets, cookies, authorization headers, and request bodies are not logged.

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

`/refresh` accepts `{ "refreshToken": "..." }` and returns a replacement access/refresh pair. `/logout` requires a current access token and returns 204. There are no login, signup, password, OAuth, or public user-creation endpoints. JSON refresh responses are for development/testing; a future browser design should prefer an HttpOnly, Secure, SameSite refresh cookie after explicit CSRF design.

The fixed Phase 8 permission is `system.echo`; persistent RBAC is not implemented. Identity persistence establishes who the caller is and whether the session is active. Tool Service remains authoritative for tool-specific permission, risk, approval, and execution policy. External JWTs are never forwarded to Agent or Tool Service.

## Boundaries

The Gateway owns HTTP ingress, identity/session persistence, request lifecycle, external errors, correlation, edge hardening, trusted downstream calls, and orchestration. It does not own LLM inference, audio processing, retrieval, tool execution, external integrations, Kafka analytics, or Agent/Tool database access. OAuth, passwords, frontend login, RBAC, WebSockets, rate limiting, Redis, and production deployment remain future milestones.

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
