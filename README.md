# AURA

**Self-Hosted Multilingual Autonomous Voice Agent**

AURA is a production-minded platform for multilingual voice interaction, self-hosted reasoning, and permission-aware tools. Capabilities enter through explicit, testable service boundaries.

## Current status

Phase 26 adds read-only `contacts.people.list` and `contacts.people.get`, using conditional `contacts.readonly` consent, exact `contacts.people.read`, fixed People API endpoints, and normalized contact summaries. Contact writes are not implemented.

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

V1 registers the three local utilities, five Google Calendar tools, and four Gmail tools through the sealed Tool Registry and centralized policy pipeline. Gmail list/get are read-only; send/reply are explicit-approved writes. Contacts, Drive, and other SaaS integrations remain unimplemented.

Redis, Kafka, CognoDB, Kubernetes, and cloud-specific deployment SDKs are not introduced. See [docs/architecture.md](docs/architecture.md) for ownership and evolution constraints.

Phase 20 adds persistent, owner-bound, expiring, single-use approval records for future risky tools. Exact actions are SHA-256 bound to canonical tool name, version, and validated input. Agent orchestration suspends before execution, an explicit authenticated browser decision consumes the stored action once, and the Tool result returns through Agent continuation. Realtime sessions emit `approval.required`, wait in `AWAITING_APPROVAL`, and resume TTS only after an HTTP approval; voice transcripts and Agent output cannot approve. All three current production tools remain approval-free.

The Google Calendar V1 set is `calendar.events.list`, `get`, `create`, `update`, and `delete`, all restricted to the authenticated user's primary calendar. Gmail provides `messages.list`/`get` with `gmail.readonly` plus approved `messages.send`/`reply` with the narrower `gmail.send` scope and exact AURA permissions. Outbound mail is single-recipient plain text, approval-bound, single-use, and never retried; reply recipients and threading metadata are resolved server-side. Older credentials require re-consent. Forward/delete/modify, drafts, attachments, CC/BCC, Contacts, and Drive remain unimplemented.
