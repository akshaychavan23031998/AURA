# AURA

**Self-Hosted Multilingual Autonomous Voice Agent**

AURA is a personal, production-minded platform for natural multilingual voice interaction, contextual reasoning, permission-aware tools, and self-hosted AI components. The project is being built incrementally so each capability enters through an explicit, testable service boundary.

## Current status

**Phase 11 — multilingual TTS and voice-quality hardening.** The local Voice Service now routes normalized English, Hindi, Hinglish, and Telugu synthesis through a typed Piper voice registry, validates every WAV result, and fails closed for unsupported Kannada. This is not streaming realtime audio; VAD, interruption, WebRTC/WebSockets, RAG, memory, and external integrations remain unimplemented.

## Planned architecture

- **Web:** Next.js user interface and realtime client.
- **Gateway:** External API entry point, policy enforcement, routing, and WebSocket lifecycle.
- **Voice:** Implemented local STT/TTS transformation; realtime streaming, VAD, and interruption are planned.
- **Agent:** Language understanding, reasoning, planning, and tool selection.
- **Tools:** Permission-aware integrations and privileged action execution.
- **Knowledge:** RAG, retrieval, contextual memory, and graph access.
- **Analytics:** Asynchronous operational and product metrics.

Realtime voice follows `Browser → WebSocket → Gateway → Voice`. Kafka is planned only for asynchronous domain events and never carries realtime audio.

## Planned infrastructure

PostgreSQL will hold transactional system-of-record data, CognoDB will hold graph-oriented contextual memory, and Redis will hold transient state. Kafka will provide the asynchronous event backbone. Docker support will arrive with runnable services; Kubernetes remains deferred until scaling requirements justify it.

## Repository structure

```text
apps/web/                 Next.js application
services/                 Documented future service boundaries
packages/                 Shared TypeScript package foundations
infrastructure/           Future Docker, Kafka, and Kubernetes assets
docs/                     Architecture decisions and system direction
```

## Development setup

### Prerequisites

- Node.js 22 LTS (see `.nvmrc`)
- pnpm 11.13.0 (Corepack can provision the version declared in `package.json`)
- Python 3.12 with isolated Agent and Voice venvs

### Install and run

```bash
corepack enable
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

### Quality checks

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Copy `.env.example` to `.env` only when local configuration is needed. Never commit credentials or model weights.

## Roadmap

- **V0:** Listen → Understand → Think → Speak
- **V1:** Tools + Actions
- **V1.5:** Memory + RAG + Permissions
- **V2:** Autonomous multi-step workflows

See [docs/architecture.md](docs/architecture.md) for boundaries and evolution constraints.
