CREATE TYPE "knowledge_source_type" AS ENUM ('manual_text');
CREATE TYPE "knowledge_status" AS ENUM ('ACTIVE', 'DELETED');

CREATE TABLE "knowledge_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "source_type" "knowledge_source_type" DEFAULT 'manual_text' NOT NULL,
  "status" "knowledge_status" DEFAULT 'ACTIVE' NOT NULL,
  "normalized_content" text NOT NULL,
  "content_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "knowledge_documents_title_length_check" CHECK (char_length("title") between 1 and 200),
  CONSTRAINT "knowledge_documents_content_bytes_check" CHECK (octet_length("normalized_content") between 1 and 131072),
  CONSTRAINT "knowledge_documents_content_hash_check" CHECK (char_length("content_hash") = 64)
);

CREATE TABLE "knowledge_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "knowledge_documents"("id") ON DELETE cascade,
  "ordinal" integer NOT NULL,
  "content" text NOT NULL,
  "content_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "knowledge_chunks_ordinal_check" CHECK ("ordinal" between 0 and 127),
  CONSTRAINT "knowledge_chunks_content_length_check" CHECK (char_length("content") between 1 and 2000),
  CONSTRAINT "knowledge_chunks_content_hash_check" CHECK (char_length("content_hash") = 64)
);

CREATE INDEX "knowledge_documents_actor_created_idx" ON "knowledge_documents" USING btree ("actor_id", "created_at");
CREATE INDEX "knowledge_documents_actor_status_idx" ON "knowledge_documents" USING btree ("actor_id", "status");
CREATE UNIQUE INDEX "knowledge_chunks_document_ordinal_uidx" ON "knowledge_chunks" USING btree ("document_id", "ordinal");
CREATE INDEX "knowledge_chunks_document_idx" ON "knowledge_chunks" USING btree ("document_id");
