# Knowledge Service

- **Responsibility:** Knowledge ingestion, chunking, embeddings, retrieval, RAG, CognoDB context-graph access, and memory retrieval.
- **Planned technology:** Python, FastAPI, Pydantic, embedding/retrieval components, and CognoDB.
- **Data ownership:** Knowledge artifacts, graph context, embeddings, and memory retrieval metadata.
- **May perform:** Expose controlled, scoped context and retrieval operations.
- **Must not perform:** Privileged external actions, tool authorization, voice processing, or broad credential access.
- **Boundary:** Other services use explicit knowledge APIs rather than unrestricted datastore access.
