CREATE TYPE "memory_kind" AS ENUM ('preference', 'fact', 'instruction', 'note');
CREATE TYPE "memory_source" AS ENUM ('user_explicit');
CREATE TYPE "memory_status" AS ENUM ('ACTIVE', 'DELETED');

CREATE TABLE "user_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "kind" "memory_kind" NOT NULL,
  "content" text NOT NULL,
  "source" "memory_source" DEFAULT 'user_explicit' NOT NULL,
  "status" "memory_status" DEFAULT 'ACTIVE' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "user_memories_content_length_check" CHECK (char_length("content") between 1 and 4096)
);

CREATE INDEX "user_memories_actor_created_idx" ON "user_memories" USING btree ("actor_id", "created_at");
CREATE INDEX "user_memories_actor_status_idx" ON "user_memories" USING btree ("actor_id", "status");
