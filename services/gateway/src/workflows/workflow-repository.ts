import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { DatabaseClient } from "../db/client.js";
import {
  workflowStepDependencies,
  workflowSteps,
  workflowStepExecutions,
  workflows,
} from "../db/schema.js";
import type { WorkflowPlan, WorkflowStep } from "./workflow-plan.js";

export interface PersistedWorkflowGraph {
  readonly workflow: typeof workflows.$inferSelect;
  readonly steps: readonly (typeof workflowSteps.$inferSelect)[];
  readonly dependencies: readonly (typeof workflowStepDependencies.$inferSelect)[];
  readonly executions: readonly (typeof workflowStepExecutions.$inferSelect)[];
}

export class WorkflowRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public createTransactional(actorId: string, plan: WorkflowPlan) {
    return this.database.db.transaction(async (transaction) => {
      const [workflow] = await transaction
        .insert(workflows)
        .values({ actorId, goal: plan.goal, status: "READY" })
        .returning();
      if (workflow === undefined)
        throw new Error("Workflow persistence failed");

      const steps = await transaction
        .insert(workflowSteps)
        .values(
          plan.steps.map((step, ordinal) => ({
            workflowId: workflow.id,
            stepKey: step.id,
            kind: step.kind,
            ordinal,
            status:
              step.dependsOn.length === 0
                ? ("READY" as const)
                : ("BLOCKED" as const),
            payload: safePayload(step),
          })),
        )
        .returning();
      if (steps.length !== plan.steps.length)
        throw new Error("Workflow step persistence failed");

      const byKey = new Map(steps.map((step) => [step.stepKey, step.id]));
      const values = plan.steps.flatMap((step) =>
        step.dependsOn.map((dependency) => ({
          workflowId: workflow.id,
          stepId: requireStepId(byKey, step.id),
          dependsOnStepId: requireStepId(byKey, dependency),
        })),
      );
      const dependencies =
        values.length === 0
          ? []
          : await transaction
              .insert(workflowStepDependencies)
              .values(values)
              .returning();
      if (dependencies.length !== values.length)
        throw new Error("Workflow dependency persistence failed");
      return { workflow, steps, dependencies, executions: [] };
    });
  }

  public async getOwned(actorId: string, workflowId: string) {
    const [workflow] = await this.database.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.actorId, actorId)))
      .limit(1);
    if (workflow === undefined) return undefined;
    const steps = await this.database.db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.workflowId, workflow.id))
      .orderBy(workflowSteps.ordinal);
    const dependencies = await this.database.db
      .select()
      .from(workflowStepDependencies)
      .where(eq(workflowStepDependencies.workflowId, workflow.id));
    const executions = await this.database.db
      .select()
      .from(workflowStepExecutions)
      .where(eq(workflowStepExecutions.workflowId, workflow.id));
    return { workflow, steps, dependencies, executions };
  }

  public listOwned(actorId: string, limit: number) {
    return this.database.db
      .select()
      .from(workflows)
      .where(eq(workflows.actorId, actorId))
      .orderBy(desc(workflows.createdAt), desc(workflows.id))
      .limit(limit);
  }

  public async cancelOwned(actorId: string, workflowId: string, now: Date) {
    return this.database.db.transaction(async (transaction) => {
      const [cancelled] = await transaction
        .update(workflows)
        .set({ status: "CANCELLED", cancelledAt: now, updatedAt: now })
        .where(
          and(
            eq(workflows.id, workflowId),
            eq(workflows.actorId, actorId),
            inArray(workflows.status, ["READY", "AWAITING_APPROVAL"]),
          ),
        )
        .returning();
      if (cancelled !== undefined)
        await transaction
          .update(workflowSteps)
          .set({ status: "CANCELLED", updatedAt: now })
          .where(
            and(
              eq(workflowSteps.workflowId, workflowId),
              inArray(workflowSteps.status, [
                "READY",
                "BLOCKED",
                "AWAITING_APPROVAL",
              ]),
            ),
          );
      const [owned] = await transaction
        .select()
        .from(workflows)
        .where(
          and(eq(workflows.id, workflowId), eq(workflows.actorId, actorId)),
        )
        .limit(1);
      return owned;
    });
  }

  public async startOwned(actorId: string, workflowId: string, now: Date) {
    const [claimed] = await this.database.db
      .update(workflows)
      .set({ status: "RUNNING", startedAt: now, updatedAt: now })
      .where(
        and(
          eq(workflows.id, workflowId),
          eq(workflows.actorId, actorId),
          eq(workflows.status, "READY"),
        ),
      )
      .returning();
    if (claimed !== undefined)
      return { claimed: true, workflow: claimed } as const;
    const [owned] = await this.database.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.actorId, actorId)))
      .limit(1);
    return owned === undefined
      ? undefined
      : ({ claimed: false, workflow: owned } as const);
  }

  public claimNext(workflowId: string, now: Date) {
    return this.database.db.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select()
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.workflowId, workflowId),
            eq(workflowSteps.status, "READY"),
          ),
        )
        .orderBy(asc(workflowSteps.ordinal))
        .limit(1);
      if (candidate === undefined) return undefined;
      const [step] = await transaction
        .update(workflowSteps)
        .set({ status: "RUNNING", startedAt: now, updatedAt: now })
        .where(
          and(
            eq(workflowSteps.id, candidate.id),
            eq(workflowSteps.status, "READY"),
          ),
        )
        .returning();
      if (step === undefined) return undefined;
      const [execution] = await transaction
        .insert(workflowStepExecutions)
        .values({
          workflowId,
          stepId: step.id,
          status: "RUNNING",
          startedAt: now,
        })
        .returning();
      if (execution === undefined)
        throw new Error("Workflow execution persistence failed");
      return { step, execution };
    });
  }

  public async getForResolution(workflowId: string) {
    const [workflow] = await this.database.db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1);
    if (workflow === undefined) return undefined;
    const [steps, dependencies, executions] = await Promise.all([
      this.database.db
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.workflowId, workflowId))
        .orderBy(workflowSteps.ordinal),
      this.database.db
        .select()
        .from(workflowStepDependencies)
        .where(eq(workflowStepDependencies.workflowId, workflowId)),
      this.database.db
        .select()
        .from(workflowStepExecutions)
        .where(eq(workflowStepExecutions.workflowId, workflowId)),
    ]);
    return { workflow, steps, dependencies, executions };
  }

  public async succeed(
    workflowId: string,
    stepId: string,
    executionId: string,
    result: unknown,
    now: Date,
  ) {
    await this.database.db.transaction(async (transaction) => {
      await transaction
        .update(workflowStepExecutions)
        .set({ status: "SUCCEEDED", result, completedAt: now })
        .where(
          and(
            eq(workflowStepExecutions.id, executionId),
            eq(workflowStepExecutions.status, "RUNNING"),
          ),
        );
      await transaction
        .update(workflowSteps)
        .set({ status: "SUCCEEDED", completedAt: now, updatedAt: now })
        .where(
          and(
            eq(workflowSteps.id, stepId),
            eq(workflowSteps.status, "RUNNING"),
          ),
        );
      await transaction.execute(
        sql`update workflow_steps candidate set status = 'READY', updated_at = ${now} where candidate.workflow_id = ${workflowId} and candidate.status = 'BLOCKED' and not exists (select 1 from workflow_step_dependencies dependency join workflow_steps required on required.id = dependency.depends_on_step_id where dependency.step_id = candidate.id and required.status <> 'SUCCEEDED')`,
      );
      const remaining = await transaction
        .select({ id: workflowSteps.id })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.workflowId, workflowId),
            sql`${workflowSteps.status} <> 'SUCCEEDED'`,
          ),
        )
        .limit(1);
      if (remaining.length === 0)
        await transaction
          .update(workflows)
          .set({ status: "COMPLETED", completedAt: now, updatedAt: now })
          .where(
            and(eq(workflows.id, workflowId), eq(workflows.status, "RUNNING")),
          );
    });
  }

  public async fail(
    workflowId: string,
    stepId: string,
    executionId: string,
    errorCode: string,
    now: Date,
  ) {
    await this.database.db.transaction(async (transaction) => {
      await transaction
        .update(workflowStepExecutions)
        .set({ status: "FAILED", errorCode, completedAt: now })
        .where(eq(workflowStepExecutions.id, executionId));
      await transaction
        .update(workflowSteps)
        .set({ status: "FAILED", completedAt: now, updatedAt: now })
        .where(eq(workflowSteps.id, stepId));
      await transaction
        .update(workflowSteps)
        .set({ status: "SKIPPED", completedAt: now, updatedAt: now })
        .where(
          and(
            eq(workflowSteps.workflowId, workflowId),
            inArray(workflowSteps.status, ["READY", "BLOCKED"]),
          ),
        );
      await transaction
        .update(workflows)
        .set({ status: "FAILED", completedAt: now, updatedAt: now })
        .where(eq(workflows.id, workflowId));
    });
  }

  public async awaitApproval(
    workflowId: string,
    stepId: string,
    executionId: string,
    approvalId: string,
    now: Date,
  ) {
    await this.database.db.transaction(async (transaction) => {
      await transaction
        .update(workflowStepExecutions)
        .set({ status: "AWAITING_APPROVAL", approvalId })
        .where(eq(workflowStepExecutions.id, executionId));
      await transaction
        .update(workflowSteps)
        .set({ status: "AWAITING_APPROVAL", updatedAt: now })
        .where(eq(workflowSteps.id, stepId));
      await transaction
        .update(workflows)
        .set({ status: "AWAITING_APPROVAL", updatedAt: now })
        .where(eq(workflows.id, workflowId));
    });
  }

  public async resumeApproval(actorId: string, approvalId: string, now: Date) {
    return this.database.db.transaction(async (transaction) => {
      const [row] = await transaction
        .select({
          execution: workflowStepExecutions,
          step: workflowSteps,
          workflow: workflows,
        })
        .from(workflowStepExecutions)
        .innerJoin(
          workflowSteps,
          eq(workflowSteps.id, workflowStepExecutions.stepId),
        )
        .innerJoin(
          workflows,
          eq(workflows.id, workflowStepExecutions.workflowId),
        )
        .where(
          and(
            eq(workflowStepExecutions.approvalId, approvalId),
            eq(workflows.actorId, actorId),
            eq(workflows.status, "AWAITING_APPROVAL"),
            eq(workflowSteps.status, "AWAITING_APPROVAL"),
            eq(workflowStepExecutions.status, "AWAITING_APPROVAL"),
          ),
        )
        .limit(1);
      if (row === undefined) return undefined;
      await transaction
        .update(workflows)
        .set({ status: "RUNNING", updatedAt: now })
        .where(eq(workflows.id, row.workflow.id));
      await transaction
        .update(workflowSteps)
        .set({ status: "RUNNING", updatedAt: now })
        .where(eq(workflowSteps.id, row.step.id));
      await transaction
        .update(workflowStepExecutions)
        .set({ status: "RUNNING" })
        .where(eq(workflowStepExecutions.id, row.execution.id));
      return row;
    });
  }

  public async canResumeApproval(actorId: string, approvalId: string) {
    const [row] = await this.database.db
      .select({ id: workflowStepExecutions.id })
      .from(workflowStepExecutions)
      .innerJoin(
        workflowSteps,
        eq(workflowSteps.id, workflowStepExecutions.stepId),
      )
      .innerJoin(workflows, eq(workflows.id, workflowStepExecutions.workflowId))
      .where(
        and(
          eq(workflowStepExecutions.approvalId, approvalId),
          eq(workflows.actorId, actorId),
          eq(workflows.status, "AWAITING_APPROVAL"),
          eq(workflowSteps.status, "AWAITING_APPROVAL"),
          eq(workflowStepExecutions.status, "AWAITING_APPROVAL"),
        ),
      )
      .limit(1);
    return row !== undefined;
  }
}

function safePayload(step: WorkflowStep): Record<string, unknown> {
  switch (step.kind) {
    case "tool":
      return { tool: step.tool };
    case "memory_read":
      return { memoryKind: step.memoryKind };
    case "memory_search":
    case "knowledge_search":
      return { query: step.query };
  }
}

function requireStepId(
  byKey: ReadonlyMap<string, string>,
  key: string,
): string {
  const id = byKey.get(key);
  if (id === undefined) throw new Error("Workflow step mapping failed");
  return id;
}
