# Tool Service

- **Responsibility:** Tool registry, external integrations, permission and approval enforcement, OAuth-backed actions, idempotency, and action execution.
- **Planned technology:** Node.js, TypeScript, Fastify, and Zod.
- **Data ownership:** Integration credentials, permission grants, execution records, approval state, and idempotency records within explicit storage boundaries.
- **May perform:** Authorized actions such as sending email, creating calendar events or tickets, and repository operations.
- **Must not perform:** Agent reasoning, voice processing, or accept unvalidated LLM output as authorization.
- **Boundary:** This is a primary security boundary. Every privileged action is validated, authorized, auditable, and approval-gated where risk requires it.
