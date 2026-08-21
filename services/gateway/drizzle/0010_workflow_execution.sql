CREATE TYPE "workflow_execution_status" AS ENUM ('RUNNING', 'AWAITING_APPROVAL', 'SUCCEEDED', 'FAILED');

CREATE TABLE "workflow_step_executions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE cascade,
  "step_id" uuid NOT NULL REFERENCES "workflow_steps"("id") ON DELETE cascade,
  "attempt_number" integer DEFAULT 1 NOT NULL,
  "status" "workflow_execution_status" NOT NULL,
  "approval_id" uuid REFERENCES "tool_approvals"("id") ON DELETE restrict,
  "result" jsonb,
  "error_code" text,
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "workflow_step_executions_step_attempt_unique" UNIQUE ("step_id", "attempt_number"),
  CONSTRAINT "workflow_step_executions_attempt_check" CHECK ("attempt_number" = 1),
  CONSTRAINT "workflow_step_executions_error_code_check" CHECK ("error_code" IS NULL OR char_length("error_code") BETWEEN 1 AND 64)
);

CREATE INDEX "workflow_step_executions_workflow_idx" ON "workflow_step_executions" ("workflow_id");
CREATE UNIQUE INDEX "workflow_step_executions_approval_uidx" ON "workflow_step_executions" ("approval_id") WHERE "approval_id" IS NOT NULL;
