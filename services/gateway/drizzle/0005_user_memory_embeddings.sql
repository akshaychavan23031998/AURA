CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "user_memory_embeddings" (
  "memory_id" uuid NOT NULL REFERENCES "user_memories"("id") ON DELETE cascade,
  "model" text NOT NULL,
  "embedding" vector(384) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_memory_embeddings_model_length_check" CHECK (char_length("model") between 1 and 128)
);

CREATE UNIQUE INDEX "user_memory_embeddings_memory_model_uidx" ON "user_memory_embeddings" USING btree ("memory_id", "model");
CREATE INDEX "user_memory_embeddings_model_idx" ON "user_memory_embeddings" USING btree ("model");
