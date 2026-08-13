# Gateway Service

The Gateway is AURA's external HTTP entry point. Phase 2 implements its production-oriented runtime foundation without application APIs or downstream integrations.

## Implemented

- Fastify application construction separated from process startup
- centrally validated, immutable configuration
- structured Pino logging with stable `service: gateway` identity
- authorization and cookie header redaction
- bounded incoming request IDs with generated fallback IDs
- `x-request-id` response correlation
- Helmet security headers
- stable not-found, application-error, validation-error, and internal-error contracts
- graceful `SIGINT` and `SIGTERM` shutdown
- liveness and readiness endpoints
- injection-based behavioral tests

## Endpoints

| Method | Path      | Purpose                           | Response                                      |
| ------ | --------- | --------------------------------- | --------------------------------------------- |
| `GET`  | `/health` | Process liveness                  | `{ "status": "ok", "service": "gateway" }`    |
| `GET`  | `/ready`  | Successful Gateway initialization | `{ "status": "ready", "service": "gateway" }` |

There is no root or versioned domain API yet. Versioned routes will be introduced with real API domains rather than placeholder endpoints.

## Configuration

Copy `.env.example` to `.env` when local overrides are needed. The service currently supports only:

| Variable       | Development default | Constraint                             |
| -------------- | ------------------- | -------------------------------------- |
| `NODE_ENV`     | `development`       | `development`, `test`, or `production` |
| `GATEWAY_HOST` | `0.0.0.0`           | non-empty host                         |
| `GATEWAY_PORT` | `4000`              | integer from 1 through 65535           |
| `LOG_LEVEL`    | `info`              | supported Pino level or `silent`       |

Configuration is read once during startup and fails fast when supplied values are malformed. The root `.env.example` remains an architectural overview; this service-local file is the executable Gateway contract.

## Development

From the repository root:

```bash
pnpm install
pnpm --filter @aura/gateway dev
```

The default health URL is <http://localhost:4000/health>. The runtime uses environment variables directly in line with Twelve-Factor principles; shell variables or a process manager can supply overrides.

```bash
pnpm --filter @aura/gateway lint
pnpm --filter @aura/gateway typecheck
pnpm --filter @aura/gateway test
pnpm --filter @aura/gateway build
pnpm --filter @aura/gateway start
```

## Boundaries

The Gateway owns HTTP ingress, request lifecycle, external error shape, correlation, and baseline edge hardening. It does not own LLM inference, STT/TTS, RAG, database domain logic, integrations, tool execution, or Kafka analytics.

Authentication, authorization coordination, rate limiting, WebSockets, service routing, CORS policy, and API documentation remain planned. They will be added only with concrete ingress and API requirements. Realtime audio will eventually pass through Gateway WebSockets to the Voice Service and will never be routed through Kafka.
