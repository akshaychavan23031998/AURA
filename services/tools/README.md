# Tool Service

The Tool Service is AURA's controlled action-execution boundary. It treats Agent and LLM output as untrusted, resolves only statically registered tools, validates every input, and centrally enforces permission and approval policy before invoking trusted code.

## Implemented in Phase 3

- Fastify runtime with validated immutable configuration
- structured Pino logging, request IDs, sensitive-field redaction, and Helmet headers
- stable error responses and graceful shutdown
- deterministic in-memory tool registry
- explicit tool definition, risk, permission, context, approval, and result contracts
- centralized executor and approval policy
- `system.echo`, the only production-registered tool
- operational, metadata, and execution endpoints

## Execution flow

```text
validated HTTP request
  → registry lookup
  → tool-owned Zod input schema
  → required-permission check
  → central approval policy
  → trusted tool implementation
  → structured result
```

The Agent may eventually propose a tool and arguments, but it cannot define a tool, change its risk, reduce its permissions, declare its own approval policy, or provide executable code.

## Endpoints

| Method | Path             | Purpose                                     |
| ------ | ---------------- | ------------------------------------------- |
| `GET`  | `/health`        | Process liveness                            |
| `GET`  | `/ready`         | Application and registry initialization     |
| `GET`  | `/tools`         | Deterministically sorted safe tool metadata |
| `POST` | `/tools/execute` | Internal execution-contract foundation      |

The server accepts JSON bodies up to 64 KiB. Tool inputs and outputs are not logged by default.

## Configuration and development

| Variable     | Default       | Constraint                             |
| ------------ | ------------- | -------------------------------------- |
| `NODE_ENV`   | `development` | `development`, `test`, or `production` |
| `TOOLS_HOST` | `0.0.0.0`     | non-empty host                         |
| `TOOLS_PORT` | `4001`        | integer from 1 through 65535           |
| `LOG_LEVEL`  | `info`        | supported Pino level or `silent`       |

```bash
pnpm --filter @aura/tools dev
pnpm --filter @aura/tools lint
pnpm --filter @aura/tools typecheck
pnpm --filter @aura/tools test
pnpm --filter @aura/tools build
pnpm --filter @aura/tools start
```

## Domain policy

- **READ:** Retrieves information without mutation. Approval is not required unless the trusted tool definition explicitly requires it.
- **WRITE:** Creates or changes state. Its definition can require approval; future state-changing adapters should normally do so.
- **DESTRUCTIVE:** Difficult-to-reverse operations. Central policy always requires approval and a tool cannot opt out.

Permissions are stable namespaced strings such as `system.echo` or future `gmail.send`. `system.echo` requires `system.echo` explicitly and only returns a validated message unchanged.

Approval assertions bind an approval identifier and reviewer to an actor and tool. They are an intentionally incomplete in-memory contract: future trusted approval records must additionally bind the exact action, arguments, expiry, and authenticated approving principal.

## Critical Phase 3 limitation

**The Phase 3 HTTP execution context is NOT a production authorization boundary.** The caller currently supplies `actorId`, permissions, and optional approval context in the request body solely to establish and test service contracts. A public caller must never be allowed to self-assign permissions such as `gmail.send`, `github.write`, or `admin.*`.

The future production flow is Browser → Gateway → authenticated identity/authorization context → Agent proposal → trusted service context → Tool Service. Approval will be created and validated by trusted services and bound to the actor, tool, exact action, and expiration window.

The Tool Service is internal and enables no browser CORS. It contains no authentication, OAuth, database, Kafka, Redis, external integration, shell, arbitrary HTTP, or filesystem execution.

## Reliability evolution

State-changing tools will eventually require persisted idempotency records. READ operations may be retried when an adapter permits it; WRITE operations may be retried only with idempotency guarantees; DESTRUCTIVE operations must never be blindly retried. External adapters must support bounded timeouts and `AbortSignal` cancellation. No retry or persistence framework exists yet.

Future domain events may include `tool.execution.requested`, `tool.execution.completed`, and `tool.execution.failed`, but Phase 3 implements no Kafka contracts or runtime.
