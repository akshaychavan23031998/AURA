# Analytics Service

- **Responsibility:** Consume asynchronous events and produce operational and product analytics such as latency, tool success, conversation metrics, language distribution, and failures.
- **Planned technology:** Implementation selected when concrete analytics requirements exist; expected to run as event consumers.
- **Data ownership:** Derived analytics datasets and aggregates, not transactional system-of-record data.
- **May perform:** Consume approved event fields and create metrics and aggregates.
- **Must not perform:** Block realtime conversations, execute tools, or become a transactional source of truth.
- **Boundary:** Operates off Kafka asynchronously and is never on the critical realtime voice path.
