# Gateway Service

## V1 — Complete

Gateway is the sole public orchestration and identity boundary for all 14 V1 tools. It derives actor permissions, resolves encrypted provider credentials, persists/consumes exact approvals, propagates request IDs, and never retries unsafe Tool writes. Agent, Voice, Web, and public request bodies cannot supply trusted actor, permission, OAuth scope, provider token, or approval proof state.

The Gateway is AURA's external HTTP and WebSocket entry point. Phase 16 adds Google OIDC account entry while preserving AURA-owned users, sessions, tokens, permissions, and voice transport.

`GOOGLE_CONTACTS_ENABLED=true` adds only `contacts.readonly` consent. Existing users require re-consent. Provider credentials remain encrypted and only an ephemeral access token crosses the internal Tool Service boundary.

Phase 27 adds authenticated Google capability management. Status is derived from enabled features and stored scopes; it excludes raw scopes, subjects, tokens, and encryption metadata. Re-consent reuses OIDC Authorization Code + PKCE and binds the protected transaction to the authenticated actor and existing Google `sub`. A callback from another Google account fails closed. If Google omits a replacement refresh token, the current encrypted token is preserved.

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

| Method   | Path                                      | Authentication           | Purpose                                          |
| -------- | ----------------------------------------- | ------------------------ | ------------------------------------------------ |
| `GET`    | `/health`                                 | None                     | Process liveness                                 |
| `GET`    | `/ready`                                  | None                     | Gateway and PostgreSQL readiness                 |
| `POST`   | `/api/v1/auth/refresh`                    | Refresh cookie/body      | Rotate refresh token and issue access token      |
| `POST`   | `/api/v1/auth/logout`                     | Bearer                   | Revoke the caller's current session              |
| `POST`   | `/api/v1/auth/development-session`        | Development only         | Create the fixed local development identity      |
| `GET`    | `/api/v1/auth/google/start`               | None                     | Start Google OIDC with state, nonce, and PKCE    |
| `GET`    | `/api/v1/auth/google/callback`            | Transaction cookie       | Validate Google identity and create AURA session |
| `GET`    | `/api/v1/integrations/google`             | Bearer                   | Read sanitized enabled Google capability state   |
| `POST`   | `/api/v1/integrations/google/reconnect`   | Bearer + Origin          | Start explicit actor-bound Google re-consent     |
| `POST`   | `/api/v1/integrations/google/disconnect`  | Bearer + Origin          | Remove only the caller's local Google credential |
| `GET`    | `/api/v1/memories`                        | Bearer + memory.read     | List active actor-owned memories                 |
| `GET`    | `/api/v1/memories/:memoryId`              | Bearer + memory.read     | Get one active actor-owned memory                |
| `POST`   | `/api/v1/memories`                        | Bearer + memory.write    | Create one explicit actor-owned memory           |
| `DELETE` | `/api/v1/memories/:memoryId`              | Bearer + memory.write    | Soft-delete one actor-owned memory               |
| `POST`   | `/api/v1/knowledge/documents`             | Bearer + knowledge.write | Ingest one owned manual-text document            |
| `GET`    | `/api/v1/knowledge/documents`             | Bearer + knowledge.read  | List owned active document metadata              |
| `GET`    | `/api/v1/knowledge/documents/:documentId` | Bearer + knowledge.read  | Get one owned active document                    |
| `DELETE` | `/api/v1/knowledge/documents/:documentId` | Bearer + knowledge.write | Soft-delete one owned document                   |
| `POST`   | `/api/v1/knowledge/search`                | Bearer + knowledge.read  | Search owned active chunks by exact cosine rank  |
| `POST`   | `/api/v1/tools/execute`                   | Bearer                   | Execute a validated Tool Service request         |
| `POST`   | `/api/v1/agent/respond`                   | Bearer                   | Produce an unexecuted planning response          |
| `POST`   | `/api/v1/agent/run`                       | Bearer                   | Run deterministic orchestration                  |
| `POST`   | `/api/v1/voice/run`                       | Bearer                   | Run one multipart voice turn                     |
| `GET`    | `/api/v1/voice/session`                   | Bearer upgrade           | Open an `aura.voice.v1` WebSocket session        |

Operational endpoints remain unversioned; application APIs use `/api/v1`.

## Persistent memory foundation

### Semantic retrieval

When `MEMORY_EMBEDDINGS_ENABLED=true`, Gateway uses the fixed `MEMORY_EMBEDDING_BASE_URL` `/v1/embeddings` endpoint and `MEMORY_EMBEDDING_MODEL`; callers cannot select either. Despite the compatibility-preserved environment prefix, the same internal runtime now embeds both explicit memories and knowledge chunks. The schema is fixed at 384 dimensions, HTTP is bounded by `MEMORY_EMBEDDING_TIMEOUT_MS`, and malformed/non-finite vectors fail closed. `MEMORY_SEARCH_LIMIT` is limited to 1–10 (default 5) and `MEMORY_SEARCH_MIN_SIMILARITY` to -1–1 (default 0.5).

`user_memory_embeddings` stores one vector per `(memory_id, model)`. Cosine distance (`<=>`) is evaluated only after joining active memories owned by the authenticated actor. Deleted, foreign-owned, unembedded, wrong-model, and below-threshold rows cannot enter Agent context. Queries, content, and vectors are not logged.

Explicit creation succeeds even when embedding fails; the failure is recorded only as safe metadata. Run `pnpm --filter @aura/gateway memory:backfill -- 25` explicitly to process up to 25 active memories missing the configured model. The command is bounded to 100, idempotent, tolerates partial failures, and is neither a public API nor a startup task.

Phase 29 started V1.5 with manual persistence. Phase 30 reuses that same MemoryService for explicit Agent-proposed reads, creates, and deletes. Gateway derives ownership from the authenticated principal and stores bounded `preference`, `fact`, `instruction`, or `note` content in PostgreSQL. Neither public callers nor the Agent can select ownership, lifecycle, source, or permissions; the source is always `user_explicit`. `memory.read` and `memory.write` are independent exact permissions, public list limits cannot exceed 50, Agent context is capped at 10, and content cannot exceed 4096 characters.

Deletion is an owner-scoped atomic soft delete. Active list/get operations exclude deleted rows, and absent, deleted, and foreign-owned identifiers use the same `MEMORY_NOT_FOUND` response to avoid existence disclosure. Request logs contain no bodies or memory content. Agent continuation receives only bounded `id`, `kind`, and `content` fields in a dedicated context explicitly framed as untrusted user data; it never receives actor, source, lifecycle, or database metadata. Tool Service remains uninvolved and its production registry remains at 14 entries.

Only clear requests such as “remember that …”, explicit saved-memory reads, and deletion by exact UUID are eligible. Ordinary statements, fuzzy deletion, automatic extraction, transcript persistence, general RAG, automatic personalization, memory restoration, and scheduled cleanup are deliberately not implemented. Voice may carry a finalized explicit memory request through the same authenticated path, but background, stale, and interrupted transcripts have no persistence authority.

## Knowledge ingestion foundation

Phase 32 adds Gateway-owned manual plaintext ingestion only. `knowledge.read` and `knowledge.write` are independent exact permissions, actor identity is always derived from the verified principal, and foreign-owned IDs use the same `KNOWLEDGE_NOT_FOUND` behavior as missing or deleted IDs. Creation accepts only strict `{ title, content }` JSON; the server assigns `manual_text`, lifecycle, hashes, chunk ordinals, timestamps, and ownership.

Content is deterministically normalized from CRLF/CR to LF, trimmed only at its boundary, rejected when empty or control-unsafe, and limited to 128 KiB after UTF-8 encoding. SHA-256 covers normalized content. Paragraph-aware local chunking targets 1,200 characters, never exceeds 2,000 characters per chunk, uses zero-based stable ordinals with no overlap, and fails above 128 chunks. A single PostgreSQL transaction inserts the document and complete chunk set, so chunk failure leaves no partial document.

Documents transition atomically from `ACTIVE` to `DELETED`. Chunk rows are retained for future lifecycle work but every internal access joins through the owner-scoped active document; deleted chunks therefore become immediately inaccessible. Lists are newest-first, limited to 20 by default and 50 maximum, and expose metadata only. Explicit owner-scoped GET may return the bounded normalized content; no public chunk endpoint exists. Titles, content, chunks, and hashes are excluded from logs.

Phase 33 persists model-aware 384-dimensional embeddings for committed knowledge chunks. Post-ingestion indexing runs only after the document transaction commits, with concurrency two and per-chunk failure isolation. Document creation remains successful when indexing is disabled or unavailable; successful vectors survive partial failure and no retry occurs automatically. Run `pnpm --filter @aura/gateway knowledge:backfill -- 25` to process a deterministic bounded batch of active-document chunks missing the current model (default 25, maximum 100).

Through Phase 33, the public knowledge API remained unchanged and never exposed vectors or indexing internals. Backfill is an operator command, not an HTTP route or startup job. There is still no Knowledge ToolDefinition, Agent/Voice knowledge contract, citation, RAG, multipart/file, PDF/DOCX, URL, Drive, Gmail attachment, or automatic ingestion path.

Phase 34 adds the explicit authenticated search route without exposing vectors. Its strict body is `{ "query": string }`; actor, model, vector, threshold, lifecycle, and limit remain server-controlled. The query is trimmed, limited to 1,024 characters, and rejected for unsafe control characters. PostgreSQL applies actor ownership, `ACTIVE` document status, current-model filtering, cosine threshold, stable ordering, and `LIMIT` inside the vector query. Configure `KNOWLEDGE_SEARCH_LIMIT` from 1–10 (default 5) and `KNOWLEDGE_SEARCH_MIN_SIMILARITY` from -1–1 (default 0.5).

Search returns only document ID, chunk ID, title, chunk content, and ordinal. It never logs query/content/vector/score data, persists queries, performs keyword fallback, embeds missing stored chunks on demand, or exposes full documents. Agent, Tool Service, and Voice remain isolated: Phase 34 has no automatic retrieval, Agent RAG, citations, or grounded answer generation.

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

## Agent grounded knowledge flow

For an explicit saved-knowledge question, Agent may propose strict `{ "type": "knowledge_search", "query": "..." }`. Gateway requires exact `knowledge.read` and calls the existing owner-scoped `KnowledgeService` directly; callers and Agent cannot choose actor, model, vector, threshold, top-k, lifecycle, or document filters. The public `POST /api/v1/knowledge/search` endpoint keeps its Phase 34 contract and is not used as an internal hop.

Ranked chunks become local `K1`...`K10` evidence references. Aggregate title/content context is capped at 16,000 Unicode characters and higher-ranked results are retained first. Agent receives only reference, bounded title/content, and ordinal. Its continuation must be a final response with bounded citation IDs. Gateway rejects unknown IDs, removes duplicates deterministically, and returns trusted citation metadata containing only reference ID, document ID, chunk ID, title, and ordinal. No chunk content, vector, score, model, actor, hash, or lifecycle state appears in citation metadata.

No-match retrieval returns a fixed answer with empty citations and avoids a second Agent call. Search/grounding failures are sanitized; `KNOWLEDGE_GROUNDING_FAILED` never exposes model output or evidence. Logs contain request ID, operation, counts, duration, and outcome only—not query, title, chunk content, generated response, vector, or score. The response's optional citations preserve existing non-RAG browser clients, and Voice continues synthesizing only `response.text`.

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

Gmail is separately gated by `GOOGLE_GMAIL_ENABLED`. Consent adds only `gmail.readonly` and the narrow `gmail.send` scope. Reads require `gmail.messages.read`; approved send/reply require `gmail.messages.send`. Reply also verifies `gmail.readonly` because its trusted recipient/thread metadata is read from the original message. Gateway resolves the ephemeral access token only at execution. Existing credentials missing any required scope fail with `PROVIDER_REAUTH_REQUIRED`; consumed side-effect approvals are not reopened or retried.
