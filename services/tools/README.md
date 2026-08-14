# Tool Service

The Tool Service is AURA's controlled action-execution boundary. It treats Agent and LLM output as untrusted, resolves only statically registered tools, validates every input, and centrally enforces permission and approval policy before invoking trusted code.

## Implemented through Phase 18

- Fastify runtime with validated immutable configuration
- structured Pino logging, request IDs, sensitive-field redaction, and Helmet headers
- stable error responses and graceful shutdown
- deterministic in-memory tool registry
- explicit tool definition, risk, permission, context, approval, and result contracts
- centralized executor and approval policy
- exactly three production tools: `system.echo`, `utility.calculator`, and `utility.datetime`
- operational, metadata, and execution endpoints
- timing-safe shared-secret authentication for internal tool routes

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

| Variable                      | Default       | Constraint                             |
| ----------------------------- | ------------- | -------------------------------------- |
| `NODE_ENV`                    | `development` | `development`, `test`, or `production` |
| `TOOLS_HOST`                  | `0.0.0.0`     | non-empty host                         |
| `TOOLS_PORT`                  | `4001`        | integer from 1 through 65535           |
| `LOG_LEVEL`                   | `info`        | supported Pino level or `silent`       |
| `INTERNAL_SERVICE_TOKEN`      | none          | required, minimum 32 characters        |
| `INTERNAL_ALLOWED_SERVICE_ID` | `gateway`     | only Gateway is accepted               |

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

## Current trust limitation

**The internal execution context is NOT user authentication.** `/tools` and `/tools/execute` require `x-aura-service-id: gateway` and `x-aura-service-token`; unauthenticated request bodies cannot self-assign permissions. Gateway still supplies a temporary local-development actor and permissions solely to establish service contracts.

The future production flow is Browser → Gateway → authenticated identity/authorization context → Agent proposal → trusted service context → Tool Service. Approval will be created and validated by trusted services and bound to the actor, tool, exact action, and expiration window.

The Tool Service is internal and enables no browser CORS. It contains no user authentication, OAuth, database, Kafka, Redis, external integration, shell, arbitrary HTTP, or filesystem execution.

The shared secret is transitional service authentication. It is required at startup, compared timing-safely, and redacted from logs. Future identity should use mTLS, workload identity, signed service tokens, or service-mesh identity, with key IDs and overlapping rotation windows. Secret rotation is not implemented now.

## Reliability evolution

State-changing tools will eventually require persisted idempotency records. READ operations may be retried when an adapter permits it; WRITE operations may be retried only with idempotency guarantees; DESTRUCTIVE operations must never be blindly retried. External adapters must support bounded timeouts and `AbortSignal` cancellation. No retry or persistence framework exists yet.

Future domain events may include `tool.execution.requested`, `tool.execution.completed`, and `tool.execution.failed`, but Phase 3 implements no Kafka contracts or runtime.

## Phase 18 tool platform contract

`ToolDefinition` is the authoritative server-side contract. Each definition has a stable namespaced name and version, title, category, strict input and output schemas, required permissions, risk and approval policy, idempotency classification, enabled state, and bounded timeout. The registry is populated from trusted imports, rejects duplicate or malformed definitions, and is sealed after startup.

The common executor resolves the registered version, rejects disabled tools, verifies server-derived permissions and trusted approval, validates input, invokes the implementation exactly once, validates output, and returns `{ status, tool, version, data }`. Exceptions, invalid outputs, and timeouts use stable sanitized errors. A timeout never causes a retry.

`GET /tools/catalog/agent` returns only the name, description, category, and JSON input schema. It omits functions, identity, permissions, risk, approval, idempotency, timeout, and internal metadata. The Agent cannot downgrade policy or grant authority.

Phase 19 registers exactly three version 1 tools:

| Tool                 | Input                     | Output                               | Permission           | Risk   | Approval |
| -------------------- | ------------------------- | ------------------------------------ | -------------------- | ------ | -------- |
| `system.echo`        | `{ message }`             | unchanged message                    | `system.echo`        | `READ` | `NONE`   |
| `utility.calculator` | `{ expression }`          | expression and finite numeric result | `utility.calculator` | `READ` | `NONE`   |
| `utility.datetime`   | `{ operation, timezone }` | UTC instant plus timezone date/time  | `utility.datetime`   | `READ` | `NONE`   |

Calculator uses a local explicit arithmetic parser—never `eval`, dynamic JavaScript, a subprocess, or a network service. Datetime accepts an explicit validated IANA timezone and uses the platform timezone database; it does not infer locations. It is classified `NON_IDEMPOTENT` because current time changes between calls, despite being read-only and safe to repeat.

Calendar, Gmail, Contacts, external SaaS integrations, approval persistence, durable idempotency, and multi-tool planning remain future work.
