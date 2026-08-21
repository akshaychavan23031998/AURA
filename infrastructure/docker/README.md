# AURA container operations

The production-like Gateway configuration forwards the Calendar, Gmail, and Contacts enablement flags plus the Gateway-only provider-token encryption key. When any integration is enabled, inject a base64-encoded 32-byte key through the environment; it is never built into an image. This configuration is validation infrastructure only and does not perform a production deployment.

## Development PostgreSQL only

`postgres.compose.yml` remains the narrow development dependency and binds PostgreSQL to `127.0.0.1:5433`. Phase 31 pins `pgvector/pgvector:0.8.1-pg17`, preserving PostgreSQL major version 17 while making the `vector` extension available. Existing PostgreSQL 17 data directories are compatible, but back up important local data before changing images; never use `down --volumes` during this transition.

```powershell
$env:POSTGRES_PASSWORD = "replace-with-local-password"
docker compose -f infrastructure/docker/postgres.compose.yml up -d
```

## Production-like stack

`production.compose.yml` builds Web, Gateway, Tools, Agent, and Voice, runs PostgreSQL, applies Drizzle migrations once, and terminates TLS with Caddy. Only Caddy publishes host ports. Agent, Voice, Tools, Gateway, and PostgreSQL are reachable only on the private Compose network.

The stack also defines a private `gateway-worker` using the Gateway image and `dist/workflow-worker.js`. The public Gateway explicitly disables polling; the worker enables it, exposes no ports, processes one workflow at a time, and coordinates replicas through PostgreSQL leases and fencing generations. This is configuration only and does not deploy the stack.

Copy `production.env.example` to an ignored file outside source control, replace every placeholder, and use an absolute model directory:

```powershell
docker compose --env-file C:\secure\aura-production.env -f infrastructure/docker/production.compose.yml config
docker compose --env-file C:\secure\aura-production.env -f infrastructure/docker/production.compose.yml build
docker compose --env-file C:\secure\aura-production.env -f infrastructure/docker/production.compose.yml up -d
```

Caddy uses an internally issued certificate for `localhost`; browsers must trust Caddy's local CA before microphone APIs behave as a secure context. A real DNS name enables Caddy's normal ACME HTTPS behavior and requires inbound ports 80/443. Set `AURA_DOMAIN` to the hostname only and `AURA_PUBLIC_ORIGIN` to the exact externally visible HTTPS origin, including a non-default port when applicable.

Startup order is PostgreSQL health, explicit migration completion, internal service readiness, Gateway readiness, Web health, then edge availability. Inspect with `docker compose ps` and structured `docker compose logs`. Stop gracefully with `docker compose down`; omit `--volumes` to preserve PostgreSQL and Caddy state.

## Migrations

Migrations are an explicit one-shot service and are never run by an HTTP request or every Gateway replica. For an independently deployed Gateway image:

```text
node dist/db/migrate.js
```

Run it once with `DATABASE_URL` before rolling out Gateway instances. Never use test reset helpers against a production database.

## Models and inference

Voice weights are provisioned out of band and mounted read-only at `/models`; images contain no weights. The Compose stack requires the faster-whisper directory plus the configured Piper `.onnx` and `.onnx.json` files in `VOICE_MODEL_PATH`.

llama.cpp remains a separately managed inference process because its CPU/GPU build, device access, and model lifecycle are host-specific. For real LLM mode, expose it only to the deployment's private network and set `AGENT_PLANNER_MODE=llm`, `LLM_BASE_URL`, and `LLM_MODEL_NAME`. Deterministic mode is appropriate only for infrastructure validation, not production reasoning.

Memory embeddings use a separate, externally provisioned OpenAI-compatible `/v1/embeddings` process. A small CPU-capable 384-dimensional embedding GGUF such as BGE Small EN v1.5 is recommended; do not reuse the Qwen chat model unless it was independently verified as an embedding model. Set the server-only `MEMORY_EMBEDDING_*` values and keep the endpoint on a private network. Images and builds never download embedding weights.

## Production secrets

Inject secrets with the target platform's secret manager or protected environment facility. Do not bake `.env` files into images. PostgreSQL, JWT, Tool, Agent, Voice, and Google credentials must be distinct. The Google client secret and JWT secret belong only to Gateway; browser builds receive only `NEXT_PUBLIC_*` values.

Register the exact Google callback `${AURA_PUBLIC_ORIGIN}/api/v1/auth/google/callback`. `WEB_APP_ORIGIN` is set to the same exact public origin by Compose. Production validation rejects HTTP origins/callbacks, and refresh/OAuth cookies are `Secure`.

## Troubleshooting

- Gateway not ready: check migration completion and PostgreSQL connectivity.
- Voice not ready: verify the read-only model mount and model filenames.
- Agent not ready in LLM mode: probe the separately managed llama.cpp `/health` endpoint from the Agent network.
- Browser microphone blocked: use trusted HTTPS and confirm browser permission.
- OAuth callback rejected: compare Google Console, `AURA_PUBLIC_ORIGIN`, and `GOOGLE_OIDC_REDIRECT_URI` byte-for-byte.
- WebSocket failure: verify the edge is serving HTTPS and that `/api/v1/voice/session` reaches Gateway; Caddy forwards upgrades automatically.
