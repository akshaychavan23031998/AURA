CREATE TYPE "public"."approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CONSUMED', 'EXPIRED');
CREATE TABLE "tool_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "tool_name" text NOT NULL,
  "tool_version" integer NOT NULL,
  "input_digest" text NOT NULL,
  "input_envelope" jsonb NOT NULL,
  "request_envelope" jsonb NOT NULL,
  "title" text NOT NULL,
  "preview" text NOT NULL,
  "status" "approval_status" DEFAULT 'PENDING' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "decided_at" timestamp with time zone,
  "consumed_at" timestamp with time zone
);
CREATE INDEX "tool_approvals_actor_status_idx" ON "tool_approvals" USING btree ("actor_id", "status");
CREATE INDEX "tool_approvals_expires_at_idx" ON "tool_approvals" USING btree ("expires_at");
