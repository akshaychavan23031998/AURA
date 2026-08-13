# Gateway Service

- **Responsibility:** External HTTP entry point, authentication enforcement, request routing, WebSocket lifecycle, rate limiting, and session coordination.
- **Planned technology:** Node.js, TypeScript, Fastify, and WebSockets.
- **Data ownership:** Gateway session/routing metadata only; authoritative domain data remains with its owning service.
- **May perform:** Validate external requests, enforce edge policies, route calls, and coordinate realtime connections.
- **Must not perform:** LLM inference, STT/TTS, business integrations, privileged tool execution, or knowledge retrieval logic.
- **Boundary:** Calls downstream services through explicit versioned contracts. It relays realtime audio to Voice and does not send audio through Kafka.
