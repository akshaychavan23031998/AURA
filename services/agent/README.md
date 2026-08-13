# Agent Service

The Agent Service is AURA's internal intent and planning boundary. Phase 5 provides a deterministic, replaceable planner; it does not use an LLM or perform actions.

## Implemented

- FastAPI application factory and centrally validated immutable settings
- public liveness/readiness and authenticated internal planning endpoints
- bounded, strict requests and stable errors
- safe request correlation and JSON logs that omit message content and credentials
- deterministic `echo <text>` tool proposals and a stable response fallback
- Ruff, Pyright, and pytest coverage

## Endpoints

| Method | Path                | Access   | Purpose                                       |
| ------ | ------------------- | -------- | --------------------------------------------- |
| `GET`  | `/health`           | Public   | Process liveness                              |
| `GET`  | `/ready`            | Public   | Successful initialization                     |
| `POST` | `/v1/agent/respond` | Internal | Return a response plan or typed tool proposal |

The planning request accepts `message`, optional `conversationId`, and optional `locale`. It cannot carry permissions, approval state, actor authority, or execution instructions.

## Development

Python 3.12 or newer is required. From the repository root:

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e "services/agent[dev]"
set AURA_INTERNAL_SERVICE_TOKEN=replace-with-at-least-32-characters
.venv/Scripts/python -m aura_agent.main
```

On POSIX, use `.venv/bin/python` and `export`. Copy `.env.example` into `services/agent/.env` only for service-local development. Settings are `APP_ENV`, `AGENT_HOST` (default `0.0.0.0`), `AGENT_PORT` (default `8001`), `LOG_LEVEL`, `AURA_INTERNAL_SERVICE_TOKEN` (required, 32+ characters), and `AURA_ALLOWED_SERVICE_ID` (fixed to `gateway`).

```bash
python -m ruff format --check services/agent
python -m ruff check services/agent
python -m pyright services/agent
python -m pytest services/agent
```

## Boundary

The service interprets requests and proposes plans. It never decides permissions or risk, approves actions, executes tools, accesses OAuth credentials, or performs external side effects. Tool Service remains authoritative for tool validation, policy, approval, and execution. AI inference, model providers, persistence, databases, Kafka, voice, RAG, WebSockets, and external integrations remain unimplemented.
