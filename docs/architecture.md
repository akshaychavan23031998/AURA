# AURA Architecture

## 1. Goals

AURA aims to become a self-hosted multilingual autonomous voice agent with natural mixed-language conversation, contextual memory, knowledge retrieval, and permission-aware action execution. The system must remain understandable, testable, secure by default, and independently evolvable.

### Implemented

Google Contacts is optional and read-only. Gateway owns encrypted credentials and verifies `contacts.readonly`; Tool Service calls only fixed People API list/get endpoints and exposes bounded names, email addresses, and phone numbers. Raw provider objects, photos, tokens, and Contacts writes remain excluded.

Phase 27 makes Google authorization status visible without conflating it with AURA authentication. Gateway derives a feature-aware capability view from encrypted credential scopes, while the browser sees only stable capability IDs and `granted`/`reauth_required` states. Re-consent reuses the encrypted OIDC transaction, PKCE, state, and nonce, binds it to the authenticated actor, and requires the verified Google subject to match the existing identity. Missing replacement refresh tokens preserve the existing encrypted token.

### V1 — Complete

V1 closes with a sealed 14-tool registry, exact non-wildcard permissions, schema-validated inputs and outputs, one Tool proposal per Agent turn, Gateway-owned orchestration, and Tool-Service-owned policy. Nine read/local tools require no approval; Calendar create/update/delete and Gmail send/reply require persistent exact-action approval and permit at most one provider dispatch. Request IDs correlate browser or voice ingress through Agent, Tool Service, provider adapters, and continuation without becoming authorization material.

V1.5/V2 capabilities are absent by design: no memory, RAG, embeddings/vector database, document ingestion, multi-step planning, durable autonomous workflows, schedules, arbitrary network/browser execution, shell/filesystem tools, Drive, or Tasks.

- Phase 1 monorepo and web foundation
- Phase 2 Fastify Gateway runtime with validated configuration, operational endpoints, request correlation, structured logging, security headers, stable external errors, and graceful shutdown
- Phase 3 Tool Service execution foundation with a trusted registry, typed contracts, input validation, permission enforcement, approval policy, and the local `system.echo` tool
- Phase 4 trusted Gateway-to-Tool-Service communication with derived development context, service authentication, correlation propagation, bounded timeout, contract validation, and safe error translation
- Phase 5 Python Agent planning foundation with deterministic intent handling, typed response/tool plans, internal authentication, and a strict Gateway-to-Agent boundary
- Phase 6 deterministic single-tool orchestration with Gateway-owned coordination, successful tool-result continuation, a hard loop limit, and explicit partial-failure semantics
- Phase 7 HS256 authentication with strict claims, immutable principals, server-derived authorization context, and protected application routes
- Phase 8 PostgreSQL-backed users, revocable sessions, transactional opaque refresh-token rotation, and per-request session enforcement
- Phase 9 self-hosted llama.cpp/Qwen3 planning with explicit planner modes, constrained JSON generation, strict plan validation, multilingual text handling, and lifecycle-aware readiness
- Phase 10 authenticated turn-based voice orchestration with bounded WAV ingress, local faster-whisper STT, local Piper TTS, correlation propagation, and explicit post-action synthesis failure semantics
- Phase 11 config-driven multilingual Piper voice selection for English, Hindi, experimental Hinglish/Telugu, conservative locale/text normalization, bounded synthesis, WAV validation, and explicit unsupported Kannada behavior
- Phase 12 authenticated `aura.voice.v1` WebSocket ingress with fixed PCM framing, deterministic server-side energy VAD, explicit one-turn state, bounded buffers, correlated lifecycle events, and chunked completed-WAV output
- Phase 13 VAD-driven barge-in with typed execution phases, request-scoped STT/Agent/TTS cancellation, superseded-turn suppression, cancellable audio delivery, and non-retriable Tool settlement sequencing
- Phase 14 browser voice client with AudioWorklet capture, deterministic 16 kHz PCM framing, validated WebSocket events, in-memory transcript state, ordered WAV playback, and authoritative interruption handling
- Phase 15 browser identity lifecycle with HttpOnly refresh cookies, memory-only access tokens, single-flight rotation, conservative authenticated retries, server-controlled development bootstrap, and coordinated voice teardown
- Phase 16 Google OIDC Authorization Code + PKCE account entry with encrypted transient state, nonce validation, durable provider-subject binding, and AURA-owned session issuance

### Planned

True streaming STT/TTS, partial transcripts, full-duplex overlap, knowledge/RAG, memory, analytics, additional credential providers, non-identity domain persistence, external tool integrations, and event infrastructure remain architectural direction rather than implemented capability.

### Safe interruption boundary

Phase 13 treats interruption as turn supersession, not transaction rollback. STT, initial Agent planning, Agent finalization, TTS, and unsent audio are request-scoped and cancellable. A Tool request becomes committed at dispatch: it receives no user-cancellation signal, is never retried, and must reach a known terminal result before a buffered replacement turn can execute. A late successful action may emit `turn.action_completed_after_interrupt` without result data; stale Agent, TTS, audio-completion, and turn-completion events remain suppressed.

The session accepts bounded PCM while old work settles. Validated speech moves the user-facing state through `INTERRUPTING` into `LISTENING`; silence and sub-threshold noise do not interrupt. Disconnect aborts only safe dependencies and audio delivery. Tool transport ambiguity remains authoritative and non-retriable.

### Browser voice boundary

The web client owns microphone permission UX, local resampling/framing, connection lifecycle, ephemeral playback, and presentation state. It does not decide interruption authority, actor identity, permissions, Tool state, or orchestration. Incoming control events are untrusted and runtime validated; binary audio is associated only with the current server-declared turn.

Because browser WebSocket APIs cannot set `Authorization`, the existing access JWT is carried in a bounded `aura.jwt.*` WebSocket subprotocol while `aura.voice.v1` is the only negotiated protocol. Gateway extracts it into the existing verifier and redacts the credential-bearing header. Production deployments require TLS/WSS. This compatibility mechanism does not change normal HTTP bearer authentication.

Browser refresh tokens are rotating opaque credentials stored only in an `HttpOnly`, `SameSite=Strict` cookie scoped to `/api/v1/auth`; production cookies are also `Secure`. The web application keeps the current access JWT in process memory and bootstraps by refreshing once before rendering authenticated UI. Cookie-backed mutations require the exact configured web `Origin`, and credentialed CORS allows only that origin. Concurrent refresh demand shares one request. Only safe HTTP methods may be retried once after refresh; action POSTs are never automatically replayed. Logout revokes the persisted session, expires the cookie, clears memory, and unmounts the voice runtime.

### Production account entry

Google authenticates the person, but Google credentials never become AURA application credentials. Gateway uses `openid-client` discovery and Authorization Code + S256 PKCE with `state`, `nonce`, exact client/redirect configuration, and only `openid email profile`. It consumes the validated ID-token claims at a narrow adapter boundary and discards provider access tokens; offline access is not requested.

The PKCE verifier, state, nonce, and issue time live for at most ten minutes in an AES-256-GCM encrypted `HttpOnly`, `SameSite=Lax` transaction cookie scoped to the callback. `Lax` is required for Google's cross-site top-level callback; the normal AURA refresh cookie remains `Strict`. Callback completion clears the transaction cookie on success and failure and redirects only to `WEB_APP_ORIGIN` with an allowlisted non-sensitive result.

`external_identities(provider, provider_subject)` is unique and binds Google `sub` to one AURA user. Email is stored only as optional verified link-time metadata and is never an account key or implicit linking mechanism. First login creates the user and binding in one transaction; unique-conflict recovery resolves concurrent first login without duplicate identities or orphaned users. A fresh normal AURA session is then created through `SessionService`.

## 2. Architectural style

AURA uses a pnpm/Turborepo monorepo containing a Next.js application, future Node.js and Python services, and narrowly scoped shared packages. The intended runtime architecture is service-oriented, but services are introduced only when a real deployable capability requires them. This preserves future independent deployment without paying distributed-systems costs prematurely.

Service communication uses explicit, versionable, runtime-validated contracts. TypeScript boundaries will pair Zod schemas with types; Python boundaries will use Pydantic. Arbitrary unvalidated payloads are not valid service contracts.

```mermaid
flowchart LR
  User --> Web[Next.js Web]
  Web --> Gateway[API Gateway]
  Gateway --> Voice[Voice Service]
  Gateway --> Agent[Agent Service]
  Gateway --> Tools[Tool Service]
  Agent --> Knowledge[Knowledge Service]
  Services[Domain Services] --> Kafka[(Kafka)]
  Kafka --> Analytics[Analytics Service]
```

## 3. Service boundaries

| Boundary  | Owns                                                                                                                                              | Explicitly excludes                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Web       | User experience and client-side interaction state                                                                                                 | Authorization decisions and secrets                     |
| Gateway   | Implemented HTTP lifecycle, OIDC account entry, identity/session persistence, correlation, errors, trusted clients, and single-tool orchestration | AI inference, audio processing, integrations, retrieval |
| Voice     | Realtime speech/audio transformation and short-lived processing state                                                                             | Planning, permissions, and business workflows           |
| Agent     | Implemented deterministic and self-hosted LLM planning with strictly validated response/tool proposals                                            | Permissions, approvals, OAuth secrets, direct actions   |
| Tools     | Implemented trusted registry and execution policy; planned integrations, credentials, persisted approvals and idempotency                         | Agent reasoning and voice processing                    |
| Knowledge | Ingestion, retrieval, embeddings, graph context, memory access                                                                                    | Privileged actions and broad credential access          |
| Analytics | Derived metrics from asynchronous events                                                                                                          | Critical-path processing and transactional truth        |

Services do not receive unrestricted access to every datastore. Each service gains only the data access its responsibility requires, exposed through controlled APIs where another service owns that data.

## 4. Realtime communication

Phase 12 adds a realtime transport and server-detected turn boundary over the existing whole-turn processing pipeline:

```mermaid
flowchart LR
  User[Authenticated user] --> Gateway[Gateway voice orchestrator]
  Gateway --> STT[Voice Service STT]
  STT --> Agent[Agent and local LLM]
  Agent --> Tools[Tool Service]
  Tools --> Agent
  Agent --> TTS[Voice Service TTS]
  TTS --> Gateway
```

Voice transforms speech only. Gateway authenticates the user, derives authority, owns orchestration, and preserves correlated request IDs across Voice, Agent, and Tools. The multipart/JSON API remains a compatibility path. WebSocket input is realtime framed PCM, but STT/TTS remain completed-turn calls and output is a chunked completed WAV; partial transcripts and streaming synthesis are not implemented.

Realtime voice uses a direct, low-latency streaming path:

```mermaid
sequenceDiagram
  participant B as Browser
  participant G as Gateway
  participant V as Voice Service
  B->>G: WebSocket audio stream
  G->>V: Realtime stream
  V-->>G: Audio/transcript stream
  G-->>B: WebSocket response
```

**Realtime voice: Browser → WebSocket → Gateway → Voice.** Audio must not travel through Kafka. The Gateway owns the external connection lifecycle; Voice owns audio processing.

## 5. Asynchronous communication

Kafka is planned for durable asynchronous domain events such as `conversation.completed`, `tool.execution.requested`, `tool.execution.completed`, and `agent.error`. Events use stable names and versioned schemas. Producers publish facts or requests; independently scalable consumers handle analytics, auditing, and workers.

```mermaid
flowchart LR
  Services[Services] -->|versioned events| Kafka[(Kafka)]
  Kafka --> Analytics[Analytics]
  Kafka --> Audit[Audit]
  Kafka --> Workers[Workers]
```

**Async events: Services → Kafka → Consumers.** Kafka configuration and event implementations are deferred until concrete workflows exist.

## 6. Datastore responsibilities

- **PostgreSQL:** Transactional system of record for users, sessions, provider credentials, approvals, and actor-owned explicit memories.
- **CognoDB:** Graph-oriented context: people, projects, systems, relationships, memories, incidents, and knowledge links.
- **Redis:** Transient sessions, cache, rate-limit state, short-lived voice state, and coordination.

The Agent Service will not directly access OAuth credentials, execute external actions, or receive unrestricted transactional database access. The Tool Service controls sensitive integrations; the Knowledge Service controls graph and retrieval access. Exact table and dataset ownership will be decided with each implemented domain.

### V1.5 Phases 29–30: persistent and explicit memory

`user_memories` stores manually submitted user data under a PostgreSQL foreign key to `users`. Its deliberately small kinds are `preference`, `fact`, `instruction`, and `note`; the only public source is the server-assigned `user_explicit`. Normal reads require `ACTIVE` status and direct `(actor_id, id)` ownership predicates. Deletion is an atomic owner-scoped transition to `DELETED` with a timestamp, and deleted or cross-owner identifiers both resolve as `MEMORY_NOT_FOUND`.

Gateway exposes bounded authenticated CRUD at `/api/v1/memories`. `memory.read` and `memory.write` are independent exact permissions, caller-supplied ownership/lifecycle/source fields fail strict validation, list results are bounded and newest-first, and content is limited to 4096 characters. Memory content is never logged.

Phase 30 adds a distinct strict Agent plan union for explicit memory read/create/delete. Gateway—not the Agent—checks `memory.read` or `memory.write`, derives ownership, calls the shared MemoryService, and returns a dedicated sanitized continuation result. Reads are intentional, newest-first, and capped at 10; creates require explicit remember/save language; deletes require an exact UUID. One turn may contain only one response, Tool, or memory action.

Memory context is untrusted persisted user content, structurally separated from system policy and never treated as authorization or executable instruction. Voice can carry a finalized explicit request through the same path, but background, stale, and interrupted transcripts are not persisted. Tool Service and its 14-tool registry are unchanged. Transcript scanning, automatic profiling/extraction, fuzzy deletion, prompt injection as authority, embeddings, semantic retrieval, vector storage, document ingestion, and RAG remain absent.

## 7. Security, errors, and observability

### Agent orchestration boundary

```mermaid
flowchart LR
  User[Authenticated user] --> Gateway
  Gateway --> Agent[Agent Service]
  Agent --> Planner[SelfHostedLlmPlanner]
  Planner --> Runtime[Local llama.cpp and Qwen3]
  Runtime --> Validation[Strict untrusted-output validation]
  Validation --> Gateway
  Gateway --> Tools[Tool Service]
  Tools --> Gateway
  Gateway --> Agent
```

The model receives only bounded planning input and safe tool-result data—never JWTs, session or refresh tokens, internal service tokens, database credentials, actors, permissions, risk, or approval state. The versioned system prompt and structured-output grammar reduce prompt-injection and format risk but do not claim immunity. User and tool-result content remain untrusted data. Unknown tools and extra privileged fields fail validation.

**LLM proposes. Gateway orchestrates. Tool Service authorizes and executes.** The local inference process loads the model once and is consumed over loopback HTTP; Agent does not spawn it from request handlers. Deterministic mode remains the safe CI fallback only when explicitly configured, while selected LLM mode fails closed if its runtime is unavailable.

```mermaid
sequenceDiagram
  participant C as Client
  participant G as Gateway Orchestrator
  participant A as Agent
  participant T as Tool Service
  C->>G: strict message envelope
  G->>A: initial plan
  A-->>G: response or untrusted tool proposal
  G->>T: proposal + trusted actor context
  T-->>G: validated successful result
  G->>A: safe tool-result continuation
  A-->>G: required final response
  G-->>C: final response
```

Agent output is untrusted planning data. It cannot grant permissions, assign risk, approve work, or call Tool Service. Gateway owns orchestration and uses authorization context derived from a verified principal; Tool Service remains authoritative for existence, input, permissions, risk, approval, and execution. TypeScript/Zod and Python/Pydantic independently validate the cross-language contract, backed by a real cross-service contract test.

Phase 6 permits exactly one tool execution. A second tool proposal fails closed because multi-step workflows require explicit iteration budgets, approval state, dependency tracking, idempotency, recovery, and loop detection. State exists only for the request lifetime. There are no retries: if a tool succeeds and final Agent generation fails, Gateway reports that the action may have completed and does not execute it again. Future state-changing workflows require durable idempotency before retry behavior can be considered.

### Tool execution boundary

```mermaid
flowchart TD
  Client[External caller] -->|strict tool + input| Gateway[Public trust boundary: Gateway]
  Gateway -->|service identity + secret; derived context| Tools[Internal Tool Service]
  Tools --> Core[Registry / Policy / Executor]
```

External callers cannot assign actor identity, permissions, approvals, or internal credentials. Gateway verifies short-lived HS256 tokens, converts their bounded subject and allowlisted grants into an immutable principal, and derives Tool context from that principal. Tool Service authenticates Gateway before accepting context and remains the permission-policy authority.

```mermaid
flowchart LR
  Client -->|Bearer JWT| Auth[Gateway verifier]
  Auth -->|AuthenticatedPrincipal| Context[Authorization context]
  Context --> Orchestrator[Gateway orchestrator]
  Orchestrator -->|internal auth; no JWT| Agent
  Orchestrator -->|internal auth + actor/grants; no JWT| Tools
```

External JWT signing and internal service authentication are distinct trust domains with separate secrets. Tokens are never forwarded to Agent or Tool Service. Phase 8 stores users, sessions, and SHA-256 refresh-token digests in PostgreSQL. Access JWTs carry persisted user `sub` and session `sid`; cryptographic validation is followed by a session/user-state lookup on every protected request, so logout, revocation, and user disable take effect immediately. Refresh rotation uses a transaction and row lock, preserves absolute session expiry, and revokes the session family when rotated evidence is replayed. HS256 remains an interim first-party mechanism intended to migrate to an external identity provider and asymmetric verification later.

Identity persistence establishes who the caller is and whether its session remains active. It does not grant tool authority: the fixed Phase 8 `system.echo` permission becomes immutable authorization context, while Tool Service remains authoritative for tool-specific permission and approval policy. A future Redis cache may reduce the per-request PostgreSQL lookup, but Redis is not part of this milestone.

```mermaid
flowchart TD
  Agent[Agent proposes action] --> Contract[Validate tool request]
  Contract --> Registry[Trusted static registry]
  Registry --> Permissions[Permission policy]
  Permissions --> Approval[Approval policy]
  Approval --> Executor[Central executor]
  Executor --> Adapter[Trusted tool adapter]
```

The Tool Service is authoritative for tool existence, input schemas, required permissions, risk, approval, and execution. Agent or LLM output cannot override those values. Gateway-derived development identity is not production authentication. Future context must derive from authenticated users and trusted services; approvals must bind actor, exact action, tool, expiry, and approving identity.

The production registry contains three local tools, five Calendar tools, four Gmail tools, and two read-only Contacts tools. Tool Service remains authoritative for schemas and exact permissions; Google credentials remain Gateway-owned. Gmail send/reply reuse the persistent approval boundary and never retry. Contacts writes, Drive, additional providers, persisted idempotency, and Kafka execution events remain planned.

- **Least privilege:** Every integration and service receives only the permissions it requires.
- **Explicit authorization:** Client state is never authority. Backend code enforces permissions and approval policy.
- **Human approval:** High-risk actions require explicit confirmation before execution.
- **Trust boundary:** LLM output proposes intent and tool calls; trusted code validates, authorizes, and executes them.
- **Auditability:** Important actions will produce durable, tamper-resistant audit records.
- **Secrets:** Keys, OAuth tokens, database credentials, private keys, and provider secrets never enter Git or logs.

Backend services will use structured internal errors, centralized translation to stable external responses, diagnostic context, and correlation/request IDs. Stack traces and internal details must not leak to users.

Structured logs are expected to support `timestamp`, `level`, `service`, `requestId`, `conversationId`, `event`, `duration`, and safe error metadata. Passwords, access tokens, OAuth secrets, and unnecessary sensitive user content must never be logged.

## 8. Deployment model

Phase 17 implements a containerized production foundation. Caddy is the only public network boundary and terminates HTTPS/WSS before routing `/api`, `/health`, and `/ready` to Gateway and all other paths to Next.js. PostgreSQL, Gateway, Tools, Agent, and Voice share a fixed private Compose subnet and publish no host ports. Gateway trusts forwarded client information only from that explicit subnet.

Application images use non-root runtime users and contain no secrets or model weights. PostgreSQL data and Caddy state use named volumes; Voice weights are an external read-only mount. Drizzle migration is a one-shot dependency that completes before Gateway starts. Gateway readiness proves database connectivity but does not apply schema changes.

llama.cpp remains separately managed because CPU/GPU binaries, accelerators, and large model lifecycle are host-specific. Agent consumes its private HTTP endpoint and never owns or kills the process. Deterministic Agent mode supports deployment smoke tests without expensive inference.

The Compose topology is a production-like validation target, not a high-availability control plane. Real production requires protected secret injection, trusted DNS, public certificates, backups, monitoring, capacity limits, and an orchestrator appropriate to measured requirements. Kubernetes remains deferred.

## 9. Evolution and testing strategy

Phase 18 establishes the V1 Tool Platform boundary. Tool Service owns statically registered immutable definitions and centrally enforces identifier/version resolution, enabled state, permissions, risk/approval policy, strict input validation, bounded one-shot execution, and output validation. Normalized results are versioned and failures never expose implementation exceptions.

The Agent-facing catalog contains only capability data: name, description, category, and input schema. It excludes actor identity, granted permissions, risk, approval, timeout, and implementation details. Gateway continues to derive trusted authorization context and orchestrate a single proposed tool.

Phase 19 proves the boundary with exactly three local version 1 implementations: `system.echo`, `utility.calculator`, and `utility.datetime`. Calculator parses a deliberately small arithmetic grammar without dynamic execution. Datetime reads server time for an explicit IANA timezone and performs no location inference or network access. Approval persistence, durable idempotency, external integrations, and multi-step planning remain planned.

Phase 20 introduces the approval lifecycle `PENDING → CONSUMED` or `PENDING → REJECTED`, with expiration enforced by PostgreSQL conditional updates. A REQUIRED Agent proposal is prepared against Tool Service metadata, persisted with its exact validated action and trusted Agent continuation request, and returned as an `approval_required` orchestration result without execution. Gateway owns records and decisions; Tool Service independently verifies an internal proof against its authoritative policy and canonical action digest. Explicit approval consumes once, executes the stored action, and passes only the normal Tool result through Agent continuation. Consumption is conservative: once reserved for dispatch it is never reusable, and ambiguous downstream outcomes are never retried.

Realtime voice emits `approval.required` and enters `AWAITING_APPROVAL`. Incoming PCM receives `VOICE_APPROVAL_PENDING`; speech, transcript text, disconnect, and reconnect have no decision authority. An active socket is notified after the authenticated HTTP decision, allowing approved Agent output to proceed through TTS or rejection to settle safely. The notifier is ephemeral while the approval record remains durable.

Calendar authorization remains separate at both layers. AURA requires exact `calendar.events.read` or `calendar.events.write` permissions; Google consent requests the official `calendar.readonly` and `calendar.events` scopes when `GOOGLE_CALENDAR_ENABLED=true`. Existing read-only credentials fail with `PROVIDER_REAUTH_REQUIRED` until re-consented. The stable Google `sub` remains the binding key. Gateway AES-256-GCM encrypts the refresh credential and attaches a bounded access token only to the authenticated Gateway→Tool context.

Gmail is independently gated by `GOOGLE_GMAIL_ENABLED`. It requests only `gmail.readonly` and `gmail.send`; Tool Service requires exact `gmail.messages.read` or `gmail.messages.send`. Gateway verifies the operation-specific scope before forwarding an ephemeral access token during execution. The adapter is fixed to `gmail.googleapis.com/gmail/v1/users/me/messages`. List/get normalize bounded metadata; send builds audited plain-text MIME; reply derives recipient, Message-ID, references, subject, and thread from a trusted metadata GET. Send/reply are approval-required, non-idempotent, single-dispatch operations with no retries; a lost provider response is an ambiguous terminal outcome. Provider tokens, raw MIME, arbitrary headers, attachments, and raw responses never enter Agent, Web, Voice, ToolResult, or logs.

Google capability management is browser-mediated and is not an Agent Tool. `GET /api/v1/integrations/google` returns only enabled capability IDs and safe state. Authenticated reconnect and disconnect mutations require the exact web Origin. Local disconnect removes the provider credential without ending the AURA session or removing its stable identity binding. `PROVIDER_REAUTH_REQUIRED` never triggers automatic navigation, OAuth, Tool retry, approval reopening, or microphone replay; the user reconnects and deliberately starts a new request. Voice can explain that browser action is required but cannot mutate integration state.

Calendar mutations are `calendar.events.create`, `update`, and `delete`. Create/update are trusted `WRITE`; delete is `DESTRUCTIVE`; all are `REQUIRED` approval, `NON_IDEMPOTENT`, and require exact `calendar.events.write`. Update PATCHes only requested allowlisted fields; delete accepts only a bounded event ID. Tool Service derives unmistakable previews and fixed primary-calendar POST/PATCH/DELETE requests. Gateway persists the exact action digest; only explicit authenticated browser approval consumes it and permits one dispatch. Preparation, approval reads, voice phrases, rejection, expiry, and card rendering cannot mutate Google. A lost mutation response is ambiguous and is never retried. Attendees, recurrence, conferencing, descriptions, additional calendars, and ACL operations are not implemented.

Capabilities enter through small milestones: define the contract and ownership, implement the simplest viable path, test it, and then operationalize it. Shared packages stay narrow and are created around demonstrated reuse rather than speculation.

Testing will use four layers:

- **Unit:** Domain and business behavior.
- **Integration:** Service-to-infrastructure boundaries.
- **Contract:** API and event compatibility.
- **End-to-end:** Critical user journeys.

The first executable backend milestone should establish the Gateway's operational skeleton and explicit health/configuration contract without introducing AI, Kafka, databases, or integrations.
