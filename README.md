# AURA

**Self-Hosted Multilingual Autonomous Voice Agent**

AURA is a production-minded platform for multilingual voice interaction, self-hosted reasoning, and permission-aware tools. Capabilities enter through explicit, testable service boundaries.

## Current status

## V1.5 — Started

Phase 29 adds the persistent user-memory foundation. Explicit authenticated REST calls can create, list, retrieve, and soft-delete actor-owned PostgreSQL memories with exact `memory.read` and `memory.write` permissions. Supported kinds are `preference`, `fact`, `instruction`, and `note`; public creation always records `user_explicit` as the trusted source. Content is trimmed at its boundary, must be non-empty, and is limited to 4096 characters.

Memory content is privacy-sensitive and is never written to structured logs. Ownership comes only from the verified AURA principal, non-owned and deleted records are indistinguishable from missing records, and all repository operations scope directly by actor. Phase 29 does not expose memory to Agent, Voice, or the Tool registry and does not implement automatic extraction, transcript storage, RAG, embeddings, vector search, document ingestion, or semantic search.

## V1 — Complete

Phase 28 formally closes V1. The sealed production registry contains exactly 14 tools: `system.echo`; `utility.calculator`; `utility.datetime`; Calendar event list/get/create/update/delete; Gmail message list/get/send/reply; and Contacts people list/get. Read tools are bounded and approval-free. Calendar mutations and Gmail send/reply are exact-action, owner-bound, expiring, single-use approved writes with no automatic retry.

Google credentials stay encrypted behind Gateway. Capability status and explicit re-consent cover Calendar, Gmail, and Contacts while preserving stable-subject binding and AURA-session independence. Provider failure, reconnect, browser refresh, WebSocket reconnect, voice input, and consumed approval state never replay a Tool action.

V1 intentionally excludes memory, RAG, embeddings/vector storage, document ingestion, multi-step planning, autonomous or scheduled workflows, Drive/Tasks, arbitrary HTTP, browser control, shell/filesystem access, and production deployment execution. V1.5 now begins with explicit memory persistence only.

**Phase 17 — production deployment foundation.** AURA now has non-root production images, an explicit migration job, a private service network, and a Caddy HTTPS/WSS edge for a repeatable production-like stack. Models and secrets remain external to images, and llama.cpp remains a separately managed inference runtime.

Implemented application capabilities include Google OIDC account entry, PostgreSQL sessions and refresh rotation, authenticated realtime voice, VAD and safe interruption, local Whisper/Piper speech, self-hosted Qwen through llama.cpp, and server-authoritative Tool execution. Kubernetes, RAG, memory, new tools, and autonomous workflows remain outside the current scope.

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
- **Later:** Memory, RAG, and explicitly bounded workflows

V1 registers three local utilities, five Google Calendar tools, four Gmail tools, and two read-only Contacts tools through the sealed Tool Registry and centralized policy pipeline. Gmail list/get and Contacts list/get are read-only; Gmail send/reply and Calendar mutations require explicit approval. Drive and other SaaS integrations remain unimplemented.

Redis, Kafka, CognoDB, Kubernetes, and cloud-specific deployment SDKs are not introduced. See [docs/architecture.md](docs/architecture.md) for ownership and evolution constraints.

Phase 20 adds persistent, owner-bound, expiring, single-use approval records for future risky tools. Exact actions are SHA-256 bound to canonical tool name, version, and validated input. Agent orchestration suspends before execution, an explicit authenticated browser decision consumes the stored action once, and the Tool result returns through Agent continuation. Realtime sessions emit `approval.required`, wait in `AWAITING_APPROVAL`, and resume TTS only after an HTTP approval; voice transcripts and Agent output cannot approve. All three current production tools remain approval-free.

The Google Calendar V1 set is `calendar.events.list`, `get`, `create`, `update`, and `delete`, all restricted to the authenticated user's primary calendar. Gmail provides `messages.list`/`get` with `gmail.readonly` plus approved `messages.send`/`reply` with the narrower `gmail.send` scope. Contacts provides bounded read-only `people.list`/`get`. The connected-account panel reports enabled capabilities without exposing tokens or raw scopes and starts protected re-consent only after an explicit click. Forward/delete/modify, drafts, attachments, CC/BCC, Contacts writes, and Drive remain unimplemented.
