# AURA container operations

## Development PostgreSQL only

`postgres.compose.yml` remains the narrow development dependency and binds PostgreSQL to `127.0.0.1:5433`.

```powershell
$env:POSTGRES_PASSWORD = "replace-with-local-password"
docker compose -f infrastructure/docker/postgres.compose.yml up -d
```

## Production-like stack

`production.compose.yml` builds Web, Gateway, Tools, Agent, and Voice, runs PostgreSQL, applies Drizzle migrations once, and terminates TLS with Caddy. Only Caddy publishes host ports. Agent, Voice, Tools, Gateway, and PostgreSQL are reachable only on the private Compose network.

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
