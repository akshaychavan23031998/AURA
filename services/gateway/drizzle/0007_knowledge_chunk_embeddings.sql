CREATE TABLE "knowledge_chunk_embeddings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chunk_id" uuid NOT NULL REFERENCES "knowledge_chunks"("id") ON DELETE cascade,
  "model" text NOT NULL,
  "embedding" vector(384) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "knowledge_chunk_embeddings_model_length_check" CHECK (char_length("model") between 1 and 128)
);

CREATE UNIQUE INDEX "knowledge_chunk_embeddings_chunk_model_uidx" ON "knowledge_chunk_embeddings" USING btree ("chunk_id", "model");
CREATE INDEX "knowledge_chunk_embeddings_model_idx" ON "knowledge_chunk_embeddings" USING btree ("model");
