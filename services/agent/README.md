# Agent Service

- **Responsibility:** Reasoning, planning, intent understanding, tool selection, and response generation.
- **Planned technology:** Python, FastAPI, Pydantic, and a vLLM-compatible self-hosted inference layer.
- **Data ownership:** Agent execution state only; no OAuth credentials or unrestricted transactional records.
- **May perform:** Produce responses and propose typed tool requests through controlled boundaries.
- **Must not perform:** Direct external actions, send email, modify calendars or repositories, access OAuth secrets, or bypass authorization and approval.
- **Boundary:** Receives validated context and asks the Tool Service to execute actions. LLM output is always untrusted input to application policy.
