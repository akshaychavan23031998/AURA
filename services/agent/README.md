# Agent Service

## V1 — Complete

Agent remains proposal-only and may select at most one of the 14 sanitized catalog tools per turn. Catalog entries contain only name, description, category, and safe input schema. JWTs, provider credentials/scopes, actor permissions, approval authority, risks, service tokens, and database details never enter the planner contract. Malformed or unknown Tool plans fail closed; Tool execution and approval remain Gateway/Tool Service responsibilities.

The Agent Service is AURA's internal planning boundary. Phase 9 preserves the deterministic planner and adds an explicitly selected self-hosted LLM planner backed by a local llama.cpp HTTP server. It proposes plans but never authorizes or executes actions.

The sanitized catalog includes Contacts list/get. Deterministic mode supports list/show contacts and exact `people/...` lookup; human-name requests require clarification rather than guessed identifiers.

Phase 18 centralizes the planner's tool knowledge in a sanitized capability catalog containing only name, description, category, and input schema. Security policy and execution authority are absent. Tool Service remains authoritative, Gateway orchestrates, and the Agent proposes at most one tool.

The catalog permits the three local tools, five Calendar tools, and Gmail list/get/send/reply. Gmail capabilities expose only bounded action schemas—not OAuth scopes, permissions, approval policy, credentials, provider state, or user IDs. Deterministic development syntax supports bounded reads plus explicit single-recipient send and message-ID reply forms; incomplete actions require clarification. The Agent only proposes writes and cannot approve them. All successful calls return through the existing one-tool continuation.

## Planner modes

- `deterministic` is the safe default for tests and development without model weights.
- `llm` uses `SelfHostedLlmPlanner` and fails startup if its configured local runtime is unavailable. It never silently falls back.

Both modes return the existing strict `RespondPlan` or `ToolPlan` contract. Model output is untrusted: llama.cpp constrains JSON generation, then Pydantic rejects malformed structures, extra fields, privileged metadata, and tools outside the sanitized catalog.

## Local model

Phase 9 selects official `Qwen/Qwen3-4B-GGUF`, `Qwen3-4B-Q4_K_M.gguf`:

- 4.0B parameters, Q4_K_M quantization, approximately 2.50 GB on disk
- 32K native context; AURA deliberately uses 4K for this planning workload
- Apache License 2.0
- 119 documented languages/dialects, including Hindi, Telugu, and Kannada
- selected for compact CPU use, multilingual coverage, JSON instruction following, and agent/tool capability

Model quality varies by language and hardware; fake multilingual tests prove UTF-8 contract handling, not linguistic quality. The real model is local-only and no hosted API or API key is used.

## Windows setup

```powershell
winget install --exact --id ggml.llamacpp
pnpm.cmd agent:model:setup
pnpm.cmd agent:model:start
```

The setup helper downloads from the official Qwen Hugging Face repository, resumes partial downloads, and verifies the Git LFS SHA-256. Weights are stored in ignored `services/agent/models/` and are never committed. The start helper binds llama.cpp to `127.0.0.1:8080`, loads the model once, uses one inference slot/four threads, and allocates a 4096-token context. Agent consumes this process; request handlers do not manage it.

In another PowerShell session:

```powershell
$env:AURA_INTERNAL_SERVICE_TOKEN = "replace-with-at-least-32-characters"
$env:AGENT_PLANNER_MODE = "llm"
$env:LLM_BASE_URL = "http://127.0.0.1:8080"
$env:LLM_MODEL_NAME = "Qwen3-4B-Q4_K_M.gguf"
services/agent/.venv/Scripts/python.exe -m aura_agent.main
```

`GET /health` is process liveness. `GET /ready` succeeds only after the selected planner initializes; LLM mode probes the already-loaded local runtime once during lifespan.

The production image runs as a non-root user and contains application dependencies but no model weights. llama.cpp is intentionally outside the image because hardware acceleration and model lifecycle are deployment-specific. Configure its private URL in LLM mode; Agent closes its HTTP inference client during graceful ASGI shutdown and never terminates the external runtime.

## Configuration

| Variable                      | Default         | Constraint                                             |
| ----------------------------- | --------------- | ------------------------------------------------------ |
| `AGENT_PLANNER_MODE`          | `deterministic` | `deterministic` or `llm`                               |
| `LLM_BASE_URL`                | none            | required in LLM mode; normally `http://127.0.0.1:8080` |
| `LLM_MODEL_NAME`              | none            | required in LLM mode                                   |
| `LLM_CONTEXT_SIZE`            | `4096`          | 1024-32768; documents runtime allocation               |
| `LLM_MAX_OUTPUT_TOKENS`       | `256`           | 64-1024                                                |
| `LLM_TEMPERATURE`             | `0.1`           | 0-1                                                    |
| `LLM_REQUEST_TIMEOUT_SECONDS` | `120`           | 1-600                                                  |

Existing `APP_ENV`, `AGENT_HOST`, `AGENT_PORT`, `LOG_LEVEL`, `AURA_INTERNAL_SERVICE_TOKEN`, and fixed `AURA_ALLOWED_SERVICE_ID=gateway` remain unchanged.

## Trust and observability

The versioned system prompt treats user messages and tool results as untrusted data. Only the static sanitized capability catalog is described; permissions, OAuth scopes, risk, approval, identity, JWTs, sessions, provider tokens, service tokens, and database credentials are never sent to the model. Initial plans cannot claim completion, and continuations are constrained to a final response.

Logs contain only metadata such as planner/runtime/model name, prompt/completion character counts, duration, plan type, and tool name. Raw prompts and completions are not logged. Inference is serialized with a one-slot semaphore, output and HTTP body sizes are bounded, and runtime/protocol failures map to the existing safe `AGENT_PLANNING_FAILED` response.

This is a self-hosted LLM-backed planning foundation, not full autonomy, prompt-injection immunity, RAG, memory, or voice capability. Gateway still limits orchestration, and Tool Service remains authoritative for tool existence, input, permissions, approval, risk, and execution.
