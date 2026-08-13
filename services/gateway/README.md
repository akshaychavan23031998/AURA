# Gateway Service

The Gateway is AURA's external HTTP entry point. Phase 8 adds PostgreSQL-backed users, revocable sessions, rotating opaque refresh tokens, and server-derived authorization context. It is an identity/session foundation, not a user-account or OAuth system.

## Implemented

- Fastify lifecycle, validated immutable configuration, structured/redacted logging, request correlation, Helmet headers, stable errors, and graceful shutdown
- liveness plus PostgreSQL-backed readiness
- trusted Agent and Tool Service clients and deterministic single-tool orchestration
- strict HS256 bearer verification with issuer, audience, lifetime, persisted user `sub`, session `sid`, version, and permission validation
- Drizzle-managed PostgreSQL users, sessions, and refresh-token history
- immediate active-session and active-user enforcement on protected requests
- transactional refresh rotation, replay-family revocation, and idempotent logout
- idempotent development-user bootstrap and development-session CLIs

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

Operational endpoints remain unversioned; application APIs use `/api/v1`.

## Configuration

The service-local `.env.example` is the executable Gateway contract; the root example remains a workspace overview.

| Variable                        | Default                 | Constraint                             |
| ------------------------------- | ----------------------- | -------------------------------------- |
| `NODE_ENV`                      | `development`           | `development`, `test`, or `production` |
| `GATEWAY_HOST`                  | `0.0.0.0`               | non-empty host                         |
| `GATEWAY_PORT`                  | `4000`                  | 1-65535                                |
| `LOG_LEVEL`                     | `info`                  | supported Pino level                   |
| `TOOLS_SERVICE_URL`             | `http://localhost:4001` | trusted HTTP/HTTPS URL                 |
| `TOOLS_SERVICE_TOKEN`           | none                    | required, 32+ characters               |
| `TOOLS_SERVICE_TIMEOUT_MS`      | `3000`                  | 100-30000 ms                           |
| `AGENT_SERVICE_URL`             | `http://localhost:8001` | trusted HTTP/HTTPS URL                 |
| `AGENT_SERVICE_TOKEN`           | none                    | required, 32+ characters               |
| `AGENT_SERVICE_TIMEOUT_MS`      | `5000`                  | 100-300000 ms; increase for local LLM  |
| `AUTH_JWT_SECRET`               | none                    | required, 32-512 characters            |
| `AUTH_JWT_ISSUER`               | `aura-gateway`          | non-empty, at most 128 characters      |
| `AUTH_JWT_AUDIENCE`             | `aura-api`              | non-empty, at most 128 characters      |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS` | `900`                   | 60-3600 seconds                        |
| `AUTH_SESSION_TTL_SECONDS`      | `604800`                | 3600-2592000 seconds                   |
| `DATABASE_URL`                  | none                    | required PostgreSQL URL                |

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
