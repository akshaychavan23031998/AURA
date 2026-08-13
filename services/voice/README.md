# Voice Service

- **Responsibility:** Audio ingestion, speech-to-text, text-to-speech, voice activity detection, streaming, interruption/barge-in, and language/audio processing.
- **Planned technology:** Python, FastAPI, Pydantic, and purpose-selected local speech models.
- **Data ownership:** Short-lived audio processing state; durable conversation records belong elsewhere.
- **May perform:** Transform and stream audio within the realtime path.
- **Must not perform:** Business workflows, integrations, authorization, ticketing, or agent planning.
- **Boundary:** Realtime audio arrives through Gateway WebSockets. Kafka is reserved for asynchronous domain events.
