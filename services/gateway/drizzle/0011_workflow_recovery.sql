CREATE TYPE "workflow_execution_checkpoint" AS ENUM ('CLAIMED', 'PREPARED', 'DISPATCH_PENDING', 'DISPATCHED', 'AWAITING_APPROVAL', 'FINALIZED', 'AMBIGUOUS');

ALTER TYPE "workflow_status" ADD VALUE 'RECOVERY_REQUIRED';
ALTER TYPE "workflow_step_status" ADD VALUE 'RECOVERY_REQUIRED';
ALTER TYPE "workflow_execution_status" ADD VALUE 'AMBIGUOUS';

ALTER TABLE "workflow_step_executions"
  ADD COLUMN "checkpoint" "workflow_execution_checkpoint" DEFAULT 'CLAIMED' NOT NULL,
  ADD COLUMN "dispatched_at" timestamptz,
  ADD COLUMN "recovery_updated_at" timestamptz;

CREATE INDEX "workflow_step_executions_recovery_idx"
  ON "workflow_step_executions" ("status", "checkpoint", "recovery_updated_at");
