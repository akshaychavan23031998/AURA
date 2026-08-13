# `@aura/kafka-events`

This package will own versioned asynchronous domain-event contracts shared by Kafka producers and consumers. It intentionally contains no events or Kafka client in Phase 1; contracts will be introduced only alongside concrete domain requirements.

Realtime audio is outside this package and must travel over the WebSocket voice path, never Kafka.
