import { and, desc, eq, inArray } from "drizzle-orm";

import type { DatabaseClient } from "../db/client.js";
import {
  workflowStepDependencies,
  workflowSteps,
  workflows,
} from "../db/schema.js";
import type { WorkflowPlan, WorkflowStep } from "./workflow-plan.js";

export interface PersistedWorkflowGraph {
  readonly workflow: typeof workflows.$inferSelect;
  readonly steps: readonly (typeof workflowSteps.$inferSelect)[];
  readonly dependencies: readonly (typeof workflowStepDependencies.$inferSelect)[];
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
      return { workflow, steps, dependencies };
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
    return { workflow, steps, dependencies };
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
            eq(workflows.status, "READY"),
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
              inArray(workflowSteps.status, ["READY", "BLOCKED"]),
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
