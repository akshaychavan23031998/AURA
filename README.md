# AURA

**Self-Hosted Multilingual Autonomous Voice Agent**

AURA is a production-minded platform for multilingual voice interaction, self-hosted reasoning, and permission-aware tools. Capabilities enter through explicit, testable service boundaries.

## Current status

## V2 — Started

Phase 40 establishes proposal-only workflow planning. Agent may propose one strict workflow with a bounded goal and at most eight ordering-only steps drawn from existing Tool, Memory read/search, and Knowledge search capabilities. Gateway independently validates the structure and dependency DAG, produces a deterministic topological proposal, and executes zero steps.

Workflow proposals contain no actor, permission, approval, provider, retry, timeout, idempotency, runtime status, result, or credential authority. Phase 40 added no persistence, execution API, result substitution, template language, scheduler, worker, retry engine, or UI. Existing Tool approvals remain mandatory in any future runtime; a workflow proposal can never satisfy approval.

Phase 41 persists validated proposals as actor-owned PostgreSQL workflows. Workflow, step, and dependency rows are committed atomically; Gateway generates all database IDs and derives the initial `READY` workflow plus `READY` root and `BLOCKED` dependent step states. Exact `workflow.read` and `workflow.write` permissions govern bounded list/detail and idempotent `READY → CANCELLED` account APIs.

Persistence still executes zero steps and creates no Tool preparation, approval, provider call, Memory/Knowledge operation, continuation, retry, result, worker, or schedule. Dependencies remain ordering metadata only.

Phase 42 adds explicit authenticated `POST /api/v1/workflows/:workflowId/run` execution. Gateway claims persisted steps with PostgreSQL compare-and-set, dispatches sequentially by ordinal, unlocks dependencies only after success, and persists one bounded sanitized execution result per step. Native Tool, `memory.read`, and `knowledge.read` permissions remain mandatory.

Required Tool approvals reuse the existing exact-action approval record and pause both workflow and step. Explicit approval resumes the linked step once; rejection, expiry, cancellation, or failure never retries. There are no workers, schedules, result substitutions, automatic recovery, Voice execution controls, or attempt two.

## V1.5 — Complete

Phase 39 formally closes V1.5. AURA now provides explicit actor-owned Memory CRUD and Agent actions, semantic Memory retrieval, manual and TXT/PDF/DOCX Knowledge ingestion, deterministic transactional chunking, local 384-dimensional pgvector indexing, explicit semantic search, grounded Agent answers with Gateway-trusted citations, and authenticated Memory/Knowledge Web management.

The completed milestone remains deliberately bounded: persistence and retrieval are explicit, permissions are exact and independent, ownership and `ACTIVE` lifecycle filters are enforced in PostgreSQL, retrieved content remains untrusted data, mutations are not replayed, and private content stays outside logs and persistent browser storage.

### Phase 38 security hardening

The V1.5 release candidate preserves direct SQL ownership and `ACTIVE` lifecycle predicates for Memory and Knowledge, independent `memory.read`/`memory.write` and `knowledge.read`/`knowledge.write` permissions, and Gateway-only persistence, retrieval, and citation authority. Retrieved and uploaded content remains untrusted data: it cannot authorize Tools, approvals, OAuth, recursive retrieval, or mutations. Embedding responses are streamed under a hard body bound, and the fixed embedding base URL rejects credentials, paths, queries, and fragments.

File ingestion additionally rejects ambiguous duplicate DOCX package parts, macro-enabled Word content types, external root document relationships, unsafe XML declarations, traversal, encryption, and archive resource abuse. Sensitive content, queries, vectors, grounded answers, and upload bodies remain outside logs and persistent browser storage. Phase 38 added no automatic extraction, autonomous behavior, new Tool, or provider.

Phase 36 adds an authenticated browser workspace for explicit Memory and Knowledge management. Users can list, create, filter, inspect, and deliberately confirm deletion of owned memories/documents; ingest manual plaintext; and run explicit semantic knowledge searches. Forms submit only the public contracts, block duplicate mutations, and keep drafts, selected files, stored content, and queries in transient component state rather than browser persistence or Redux.

The responsive navigation preserves Conversation/Voice and connected Google capability management. Structured citation rendering accepts only Gateway-returned citation metadata; model-like `[K…]` text is never promoted into a trusted source. Gateway remains authoritative for identity, permissions, ownership, lifecycle, normalization, chunking, embeddings, and search policy.

Phase 37 adds explicit authenticated TXT, text-based PDF, and DOCX uploads at `POST /api/v1/knowledge/files`. Uploads are limited to 10 MiB and validated by extension, media type, signatures/container structure, and bounded extraction. PDF parsing extracts text only; DOCX parsing reads only bounded Word Open XML without filesystem extraction, macros, external links, or embedded objects. The original binary is never persisted or logged. Server-derived text enters the existing normalization, transactional chunk persistence, best-effort embedding, semantic retrieval, and grounded-citation pipeline.

Scanned PDFs, OCR, macro-enabled Office documents, URLs, Drive, attachments, automatic ingestion, transcript ingestion, background RAG, and autonomous behavior remain unsupported.

Phase 32 adds explicit authenticated manual-text knowledge ingestion. Gateway normalizes at most 128 KiB of UTF-8 text, hashes it with SHA-256, creates deterministic paragraph-aware chunks, and persists the actor-owned document and all chunks in one PostgreSQL transaction. `knowledge.read` and `knowledge.write` are independent exact permissions; list/get/delete queries scope ownership directly in SQL and soft-deleted documents are indistinguishable from missing or foreign-owned records.

Phase 33 indexes those committed chunks with the same fixed, local 384-dimensional embedding runtime used by memory. Vectors live in model-aware `knowledge_chunk_embeddings` rows with one row per chunk/model. Post-ingestion indexing is best effort, uses concurrency two, never rolls back a stored document, and retains successful vectors when another chunk fails. Operators can run bounded, idempotent `pnpm --filter @aura/gateway knowledge:backfill -- 25`; it selects only chunks of `ACTIVE` documents and never runs at startup.

Phase 35 makes saved knowledge explicitly usable by the Agent. The first Agent call may propose one strict `knowledge_search`; Gateway checks `knowledge.read`, calls the owner-scoped Phase 34 service directly, assigns response-local `K1`...`K10` references, and forwards at most 16,000 characters of ranked evidence. The continuation is final-answer-only and returns citation IDs, while Gateway resolves those IDs to trusted document/chunk metadata. Unknown citations fail closed, duplicate citations are normalized, and a zero-result search returns a deterministic no-match response without another model call.

Retrieved chunks remain untrusted user-authored evidence: they cannot override policy, authorize actions, trigger Tools/OAuth/approvals/memory mutations, or recursively search. Queries, evidence, titles, vectors, and grounded response text are not logged. Retrieval is explicit rather than automatic; insufficient evidence must be stated, and no file/URL ingestion, hybrid search, reranking, or autonomous workflow is introduced.

Knowledge ingestion and search are Gateway account-data APIs, not Agent Tools. Phase 34 adds authenticated `POST /api/v1/knowledge/search`: Gateway embeds a bounded query through the fixed local model, then PostgreSQL performs exact cosine ranking over only the authenticated actor's `ACTIVE`, current-model chunks. `KNOWLEDGE_SEARCH_LIMIT` defaults to five and is capped at ten; `KNOWLEDGE_SEARCH_MIN_SIMILARITY` defaults to 0.5 and cannot be supplied by callers. Results contain bounded chunk content and document metadata but no vector, score, model, hash, lifecycle, or ownership internals.

Queries are neither persisted nor logged. Unembedded, wrong-model, foreign-owned, deleted, and below-threshold chunks are absent rather than triggering fallback. Agent, Tool Service, and Voice still receive no knowledge context automatically. Phase 34 adds no Agent RAG, citations, full-document synthesis, file/URL ingestion, or automatic retrieval.

Phase 31 adds semantic retrieval over explicit memories only. Gateway calls a separately provisioned local OpenAI-compatible embedding endpoint with a fixed server-configured 384-dimensional model, persists vectors in PostgreSQL/pgvector, and performs cosine search with actor ownership and `ACTIVE` lifecycle predicates inside the ranking query. Search is explicit, requires `memory.read`, returns at most five qualifying memories by default, and never exposes vectors or similarity scores to Agent or browser.

Memory persistence remains available when embeddings are disabled or temporarily unavailable. A saved memory can exist without a vector until the bounded `pnpm --filter @aura/gateway memory:backfill -- 25` command embeds it. Backfill skips deleted and already-embedded memories and never runs automatically at startup. Semantic results remain untrusted user-authored context. Phase 31 adds no automatic personalization, document ingestion, citations, or general RAG.

Phase 29 added the persistent user-memory foundation. Phase 30 adds explicit conversational memory actions: the Agent may propose one bounded read, create, or delete operation, while Gateway derives the actor, checks exact `memory.read`/`memory.write` permissions, and uses the same PostgreSQL MemoryService as the manual API. Supported kinds remain `preference`, `fact`, `instruction`, and `note`; creation always records `user_explicit` as the trusted source. Content is trimmed at its boundary, must be non-empty, and is limited to 4096 characters.

Memory content is privacy-sensitive and is never written to structured logs. Ownership comes only from the verified AURA principal, non-owned and deleted records are indistinguishable from missing records, and all repository operations scope directly by actor. Memory is read only for explicit saved-memory requests and is forwarded in a dedicated bounded context marked as untrusted user data. Ordinary statements are never persisted; there is no automatic extraction, profiling, transcript storage, or automatic personalization. The production Tool registry remains unchanged at 14 tools.

## V1 — Complete

Phase 28 formally closes V1. The sealed production registry contains exactly 14 tools: `system.echo`; `utility.calculator`; `utility.datetime`; Calendar event list/get/create/update/delete; Gmail message list/get/send/reply; and Contacts people list/get. Read tools are bounded and approval-free. Calendar mutations and Gmail send/reply are exact-action, owner-bound, expiring, single-use approved writes with no automatic retry.

Google credentials stay encrypted behind Gateway. Capability status and explicit re-consent cover Calendar, Gmail, and Contacts while preserving stable-subject binding and AURA-session independence. Provider failure, reconnect, browser refresh, WebSocket reconnect, voice input, and consumed approval state never replay a Tool action.

V1 intentionally excluded memory. The completed V1.5 milestone adds explicit and semantic memory, bounded knowledge ingestion and indexing, semantic knowledge retrieval, grounded Agent answers, trusted citations, and authenticated management UI without changing the sealed V1 Tool surface. Multi-step planning, autonomous or scheduled workflows, Drive/Tasks, arbitrary HTTP, browser control, shell/filesystem access, and production deployment execution remain excluded.

**Phase 17 — production deployment foundation.** AURA now has non-root production images, an explicit migration job, a private service network, and a Caddy HTTPS/WSS edge for a repeatable production-like stack. Models and secrets remain external to images, and llama.cpp remains a separately managed inference runtime.

Implemented application capabilities include Google OIDC account entry, PostgreSQL sessions and refresh rotation, authenticated realtime voice, VAD and safe interruption, local Whisper/Piper speech, self-hosted Qwen through llama.cpp, server-authoritative Tool execution, explicit Memory, and bounded Knowledge/RAG. Kubernetes execution, new tools, and autonomous workflows remain outside the current scope.

## Architecture

- **Web:** Next.js authenticated realtime voice client.
- **Gateway:** Public HTTP/WebSocket boundary, identity, sessions, request lifecycle, voice coordination, and orchestration.
- **Voice:** Internal local whole-turn STT/TTS transformation.
- **Agent:** Internal language understanding, reasoning, and tool proposal.
- **Tools:** Internal permission-aware action execution.
- **PostgreSQL:** Transactional identity and session system of record.
- **Caddy:** Production HTTPS/WSS edge and the only public container boundary.

Realtime voice follows `Browser → Caddy → Gateway → Voice`, with Gateway coordinating Agent and Tool calls. Internal services are not published by the production-like Compose topology.

## Repository structure

```text
apps/web/                 Next.js application
services/                 Gateway, Agent, Voice, Tools, and future boundaries
packages/                 Narrow shared TypeScript foundations
infrastructure/docker/    Development PostgreSQL and production-like stack
docs/                     Architecture decisions and system direction
```

## Development setup

Prerequisites are Node.js 22 LTS, pnpm 11.13.0, Python 3.12, and isolated Agent and Voice virtual environments.

```bash
corepack enable
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Copy `.env.example` only when local configuration is needed; never commit credentials or model weights.

## Production-like deployment

The Compose stack runs Web, Gateway, Tools, Agent, Voice, PostgreSQL, a one-shot migration, and Caddy. Model weights are mounted read-only and secrets are injected at runtime.

See [infrastructure/docker/README.md](infrastructure/docker/README.md) for configuration, TLS, startup, migration, model provisioning, shutdown, and troubleshooting instructions.

## Quality checks

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Roadmap boundaries

- **V0:** Listen → Understand → Think → Speak
- **V1:** Tools and actions
- **V1.5:** Explicit Memory, bounded Knowledge/RAG, and trusted citations — complete
- **V2:** Autonomous multi-step workflows — started with proposal-only planning

V2 begins only after this checkpoint. It may introduce a strict workflow plan contract, durable workflow and step state, dependency ordering, pause/resume and recovery, idempotency, workflow-scoped approvals, bounded autonomy policy, and workflow UI. None of those capabilities exists in V1.5.

V1 registers three local utilities, five Google Calendar tools, four Gmail tools, and two read-only Contacts tools through the sealed Tool Registry and centralized policy pipeline. Gmail list/get and Contacts list/get are read-only; Gmail send/reply and Calendar mutations require explicit approval. Drive and other SaaS integrations remain unimplemented.

Redis, Kafka, CognoDB, Kubernetes, and cloud-specific deployment SDKs are not introduced. See [docs/architecture.md](docs/architecture.md) for ownership and evolution constraints.

Phase 20 adds persistent, owner-bound, expiring, single-use approval records for future risky tools. Exact actions are SHA-256 bound to canonical tool name, version, and validated input. Agent orchestration suspends before execution, an explicit authenticated browser decision consumes the stored action once, and the Tool result returns through Agent continuation. Realtime sessions emit `approval.required`, wait in `AWAITING_APPROVAL`, and resume TTS only after an HTTP approval; voice transcripts and Agent output cannot approve. All three current production tools remain approval-free.

The Google Calendar V1 set is `calendar.events.list`, `get`, `create`, `update`, and `delete`, all restricted to the authenticated user's primary calendar. Gmail provides `messages.list`/`get` with `gmail.readonly` plus approved `messages.send`/`reply` with the narrower `gmail.send` scope. Contacts provides bounded read-only `people.list`/`get`. The connected-account panel reports enabled capabilities without exposing tokens or raw scopes and starts protected re-consent only after an explicit click. Forward/delete/modify, drafts, attachments, CC/BCC, Contacts writes, and Drive remain unimplemented.
