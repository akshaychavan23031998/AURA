CREATE TYPE "workflow_status" AS ENUM ('READY', 'RUNNING', 'AWAITING_APPROVAL', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "workflow_step_kind" AS ENUM ('tool', 'memory_read', 'memory_search', 'knowledge_search');
CREATE TYPE "workflow_step_status" AS ENUM ('READY', 'BLOCKED', 'RUNNING', 'AWAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED');

CREATE TABLE "workflows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "goal" text NOT NULL,
  "status" "workflow_status" DEFAULT 'READY' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "cancelled_at" timestamptz,
  CONSTRAINT "workflows_goal_length_check" CHECK (char_length("goal") between 1 and 1024)
);

CREATE TABLE "workflow_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE cascade,
  "step_key" varchar(64) NOT NULL,
  "kind" "workflow_step_kind" NOT NULL,
  "ordinal" integer NOT NULL,
  "status" "workflow_step_status" NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  CONSTRAINT "workflow_steps_key_length_check" CHECK (char_length("step_key") between 1 and 64),
  CONSTRAINT "workflow_steps_ordinal_check" CHECK ("ordinal" between 0 and 7),
  CONSTRAINT "workflow_steps_workflow_key_unique" UNIQUE ("workflow_id", "step_key"),
  CONSTRAINT "workflow_steps_workflow_ordinal_unique" UNIQUE ("workflow_id", "ordinal"),
  CONSTRAINT "workflow_steps_workflow_id_unique" UNIQUE ("workflow_id", "id")
);

CREATE TABLE "workflow_step_dependencies" (
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE cascade,
  "step_id" uuid NOT NULL,
  "depends_on_step_id" uuid NOT NULL,
  CONSTRAINT "workflow_step_dependencies_pk" PRIMARY KEY ("workflow_id", "step_id", "depends_on_step_id"),
  CONSTRAINT "workflow_step_dependencies_not_self_check" CHECK ("step_id" <> "depends_on_step_id"),
  CONSTRAINT "workflow_step_dependencies_step_fk" FOREIGN KEY ("workflow_id", "step_id") REFERENCES "workflow_steps"("workflow_id", "id") ON DELETE cascade,
  CONSTRAINT "workflow_step_dependencies_depends_fk" FOREIGN KEY ("workflow_id", "depends_on_step_id") REFERENCES "workflow_steps"("workflow_id", "id") ON DELETE cascade
);

CREATE INDEX "workflows_actor_created_idx" ON "workflows" ("actor_id", "created_at");
CREATE INDEX "workflows_actor_status_idx" ON "workflows" ("actor_id", "status");
