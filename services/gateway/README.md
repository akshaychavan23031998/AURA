# Gateway Service

The Gateway is AURA's external HTTP entry point. Phase 5 adds a trusted Agent Service client and strict planning route while real user authentication remains deferred.

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
- strict public tool-execution envelope and server-derived development context
- authenticated Tool Service client with timeout, contract validation, and error translation
- authenticated Agent Service client with correlation, timeout, contract validation, and safe error translation

## Endpoints

| Method | Path                    | Purpose                           | Response                                      |
| ------ | ----------------------- | --------------------------------- | --------------------------------------------- |
| `GET`  | `/health`               | Process liveness                  | `{ "status": "ok", "service": "gateway" }`    |
| `GET`  | `/ready`                | Successful Gateway initialization | `{ "status": "ready", "service": "gateway" }` |
| `POST` | `/api/v1/tools/execute` | External tool envelope            | Validated Tool Service result                 |
| `POST` | `/api/v1/agent/respond` | External planning envelope        | Response plan or unexecuted tool proposal     |

Operational endpoints remain unversioned; application APIs use `/api/v1`.

## Configuration

Copy `.env.example` to `.env` when local overrides are needed. The service currently supports only:

| Variable                   | Development default     | Constraint                             |
| -------------------------- | ----------------------- | -------------------------------------- |
| `NODE_ENV`                 | `development`           | `development`, `test`, or `production` |
| `GATEWAY_HOST`             | `0.0.0.0`               | non-empty host                         |
| `GATEWAY_PORT`             | `4000`                  | integer from 1 through 65535           |
| `LOG_LEVEL`                | `info`                  | supported Pino level or `silent`       |
| `TOOLS_SERVICE_URL`        | `http://localhost:4001` | trusted HTTP/HTTPS URL                 |
| `TOOLS_SERVICE_TOKEN`      | none                    | required, minimum 32 characters        |
| `TOOLS_SERVICE_TIMEOUT_MS` | `3000`                  | 100–30000 ms                           |
| `AGENT_SERVICE_URL`        | `http://localhost:8001` | trusted HTTP/HTTPS URL                 |
| `AGENT_SERVICE_TOKEN`      | none                    | required, minimum 32 characters        |
| `AGENT_SERVICE_TIMEOUT_MS` | `5000`                  | 100–30000 ms                           |

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

## Trusted tool path

The public route accepts only `{ "tool": string, "input": unknown }`; strict validation rejects caller-supplied identity, permissions, approvals, and internal credentials. Gateway currently derives the temporary actor `local-dev-user` with only `system.echo` and no approval. This is not user authentication.

Gateway JSON bodies are capped at 64 KiB; voice and file payloads belong on purpose-built transports.

The dedicated client authenticates as `gateway`, forwards `x-request-id`, validates all downstream JSON contracts, and aborts after the configured timeout. Execution POSTs are never automatically retried because future actions may mutate state without idempotency guarantees. Tool errors map to stable 400/403/404/409 responses; unavailable, timed-out, and malformed upstreams map to 502/504/502 without exposing URLs, tokens, fetch errors, or downstream messages.

Gateway readiness reports its own initialization and does not synchronously probe Tool Service, avoiding cascading probe failures. Tool availability is evaluated at execution time.

## Trusted Agent path

The public Agent route accepts only `message`, optional `conversationId`, and optional `locale`. Gateway rejects caller-supplied permissions, actors, approvals, credentials, and execution directives, authenticates to Agent Service, and propagates the request ID. Returned tool plans are proposals only: Gateway does not route them to Tool Service or execute them. Agent readiness is deliberately not folded into Gateway readiness.
