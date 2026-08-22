import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { DatabaseClient } from "../db/client.js";
import {
  workflowStepDependencies,
  workflowSteps,
  workflowStepExecutions,
  workflowPermissionGrants,
  workflows,
} from "../db/schema.js";
import type { WorkflowPlan, WorkflowStep } from "./workflow-plan.js";

export interface PersistedWorkflowGraph {
  readonly workflow: typeof workflows.$inferSelect;
  readonly steps: readonly (typeof workflowSteps.$inferSelect)[];
  readonly dependencies: readonly (typeof workflowStepDependencies.$inferSelect)[];
  readonly executions: readonly (typeof workflowStepExecutions.$inferSelect)[];
}

export type WorkflowAmbiguityResolution =
  "CONFIRMED_EXECUTED" | "CONFIRMED_NOT_EXECUTED";

export type WorkflowAmbiguityResolutionResult =
  | {
      readonly outcome: "RESOLVED";
      readonly workflow: typeof workflows.$inferSelect;
    }
  | {
      readonly outcome: "RESULT_REQUIRED";
    }
  | {
      readonly outcome: "NOT_FOUND";
    }
  | {
      readonly outcome: "STATE_INVALID";
    };

export class WorkflowRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public createTransactional(actorId: string, plan: WorkflowPlan) {
    return this.database.db.transaction(async (transaction) => {
      const [workflow] = await transaction
        .insert(workflows)
        .values({
          actorId,
          goal: plan.goal,
          status: "READY",
        })
        .returning();

      if (workflow === undefined) {
        throw new Error("Workflow persistence failed");
      }

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

      if (steps.length !== plan.steps.length) {
        throw new Error("Workflow step persistence failed");
      }

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

      if (dependencies.length !== values.length) {
        throw new Error("Workflow dependency persistence failed");
      }

      return {
        workflow,
        steps,
        dependencies,
        executions: [],
      };
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

    return {
      workflow,
      steps,
      dependencies,
      executions,
    };
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
        .set({
          status: "CANCELLED",
          cancelledAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(workflows.id, workflowId),
            eq(workflows.actorId, actorId),
            inArray(workflows.status, ["READY", "AWAITING_APPROVAL"]),
          ),
        )
        .returning();

      if (cancelled !== undefined) {
        await transaction
          .update(workflowSteps)
          .set({
            status: "CANCELLED",
            updatedAt: now,
          })
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
      }

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
      .set({
        status: "RUNNING",
        startedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(workflows.id, workflowId),
          eq(workflows.actorId, actorId),
          eq(workflows.status, "READY"),
        ),
      )
      .returning();

    if (claimed !== undefined) {
      return {
        claimed: true,
        workflow: claimed,
      } as const;
    }

    const [owned] = await this.database.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.actorId, actorId)))
      .limit(1);

    return owned === undefined
      ? undefined
      : ({
          claimed: false,
          workflow: owned,
        } as const);
  }

  public async requestExecutionOwned(
    actorId: string,
    workflowId: string,
    permissions: readonly string[],
    now: Date,
  ) {
    const workflow = await this.database.db.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(workflows)
        .set({
          executionRequestedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(workflows.id, workflowId),
            eq(workflows.actorId, actorId),
            eq(workflows.status, "READY"),
          ),
        )
        .returning();

      if (updated === undefined) return undefined;

      await transaction
        .delete(workflowPermissionGrants)
        .where(eq(workflowPermissionGrants.workflowId, workflowId));

      const unique = [...new Set(permissions)].sort();

      if (unique.length > 0) {
        await transaction.insert(workflowPermissionGrants).values(
          unique.map((permission) => ({
            workflowId,
            permission,
          })),
        );
      }

      return updated;
    });

    if (workflow !== undefined) return workflow;

    const [owned] = await this.database.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.actorId, actorId)))
      .limit(1);

    return owned;
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
        .set({
          status: "RUNNING",
          startedAt: now,
          updatedAt: now,
        })
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

      if (execution === undefined) {
        throw new Error("Workflow execution persistence failed");
      }

      return {
        step,
        execution,
      };
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

    return {
      workflow,
      steps,
      dependencies,
      executions,
    };
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
        .set({
          status: "SUCCEEDED",
          checkpoint: "FINALIZED",
          result,
          completedAt: now,
        })
        .where(
          and(
            eq(workflowStepExecutions.id, executionId),
            eq(workflowStepExecutions.status, "RUNNING"),
          ),
        );

      await transaction
        .update(workflowSteps)
        .set({
          status: "SUCCEEDED",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(workflowSteps.id, stepId),
            eq(workflowSteps.status, "RUNNING"),
          ),
        );

      await unlockSatisfiedSteps(transaction, workflowId, now);

      const remaining = await transaction
        .select({
          id: workflowSteps.id,
        })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.workflowId, workflowId),
            sql`${workflowSteps.status} <> 'SUCCEEDED'`,
          ),
        )
        .limit(1);

      if (remaining.length === 0) {
        await transaction
          .update(workflows)
          .set({
            status: "COMPLETED",
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(eq(workflows.id, workflowId), eq(workflows.status, "RUNNING")),
          );
      }
    });
  }

  public async checkpoint(
    executionId: string,
    expected: readonly (
      | "CLAIMED"
      | "PREPARED"
      | "DISPATCH_PENDING"
      | "DISPATCHED"
      | "AWAITING_APPROVAL"
    )[],
    checkpoint: "PREPARED" | "DISPATCH_PENDING" | "AWAITING_APPROVAL",
    now: Date,
  ) {
    const [updated] = await this.database.db
      .update(workflowStepExecutions)
      .set({
        checkpoint,
        recoveryUpdatedAt: now,
        ...(checkpoint === "DISPATCH_PENDING"
          ? {
              dispatchedAt: now,
            }
          : {}),
      })
      .where(
        and(
          eq(workflowStepExecutions.id, executionId),
          eq(workflowStepExecutions.status, "RUNNING"),
          inArray(workflowStepExecutions.checkpoint, expected),
        ),
      )
      .returning();

    return updated;
  }

  public async recordDispatchedResult(
    executionId: string,
    result: unknown,
    now: Date,
  ) {
    const [updated] = await this.database.db
      .update(workflowStepExecutions)
      .set({
        checkpoint: "DISPATCHED",
        result,
        recoveryUpdatedAt: now,
      })
      .where(
        and(
          eq(workflowStepExecutions.id, executionId),
          eq(workflowStepExecutions.status, "RUNNING"),
          eq(workflowStepExecutions.checkpoint, "DISPATCH_PENDING"),
        ),
      )
      .returning();

    return updated;
  }

  public async claimRecoveryOwned(
    actorId: string,
    workflowId: string,
    staleBefore: Date,
    now: Date,
  ) {
    return this.database.db.transaction(async (transaction) => {
      const [candidate] = await transaction
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
            eq(workflows.id, workflowId),
            eq(workflows.actorId, actorId),
            eq(workflows.status, "RUNNING"),
            eq(workflowSteps.status, "RUNNING"),
            eq(workflowStepExecutions.status, "RUNNING"),
            sql`coalesce(${workflowStepExecutions.recoveryUpdatedAt}, ${workflowStepExecutions.startedAt}) <= ${staleBefore}`,
          ),
        )
        .limit(1);

      if (candidate === undefined) return undefined;

      const [claimed] = await transaction
        .update(workflowStepExecutions)
        .set({
          recoveryUpdatedAt: now,
        })
        .where(
          and(
            eq(workflowStepExecutions.id, candidate.execution.id),
            eq(workflowStepExecutions.status, "RUNNING"),
            sql`coalesce(${workflowStepExecutions.recoveryUpdatedAt}, ${workflowStepExecutions.startedAt}) <= ${staleBefore}`,
          ),
        )
        .returning();

      return claimed === undefined
        ? undefined
        : {
            ...candidate,
            execution: claimed,
          };
    });
  }

  public async markAmbiguous(
    workflowId: string,
    stepId: string,
    executionId: string,
    now: Date,
  ) {
    await this.database.db.transaction(async (transaction) => {
      await transaction
        .update(workflowStepExecutions)
        .set({
          status: "AMBIGUOUS",
          checkpoint: "AMBIGUOUS",
          errorCode: "WORKFLOW_EXECUTION_AMBIGUOUS",
          completedAt: now,
          recoveryUpdatedAt: now,
        })
        .where(eq(workflowStepExecutions.id, executionId));

      await transaction
        .update(workflowSteps)
        .set({
          status: "RECOVERY_REQUIRED",
          updatedAt: now,
          completedAt: now,
        })
        .where(eq(workflowSteps.id, stepId));

      await transaction
        .update(workflows)
        .set({
          status: "RECOVERY_REQUIRED",
          updatedAt: now,
        })
        .where(eq(workflows.id, workflowId));
    });
  }

  public async resolveAmbiguousOwned(
    actorId: string,
    workflowId: string,
    resolution: WorkflowAmbiguityResolution,
    now: Date,
  ): Promise<WorkflowAmbiguityResolutionResult> {
    try {
      return await this.database.db.transaction(async (transaction) => {
        const [workflow] = await transaction
          .select()
          .from(workflows)
          .where(
            and(eq(workflows.id, workflowId), eq(workflows.actorId, actorId)),
          )
          .limit(1)
          .for("update");

        if (workflow === undefined) {
          return {
            outcome: "NOT_FOUND",
          };
        }

        if (workflow.status !== "RECOVERY_REQUIRED") {
          return {
            outcome: "STATE_INVALID",
          };
        }

        const rows = await transaction
          .select({
            execution: workflowStepExecutions,
            step: workflowSteps,
          })
          .from(workflowStepExecutions)
          .innerJoin(
            workflowSteps,
            eq(workflowSteps.id, workflowStepExecutions.stepId),
          )
          .where(
            and(
              eq(workflowStepExecutions.workflowId, workflowId),
              eq(workflowStepExecutions.status, "AMBIGUOUS"),
              eq(workflowStepExecutions.checkpoint, "AMBIGUOUS"),
              eq(workflowSteps.status, "RECOVERY_REQUIRED"),
            ),
          )
          .orderBy(workflowSteps.ordinal);

        if (rows.length !== 1) {
          return {
            outcome: "STATE_INVALID",
          };
        }

        const ambiguous = rows[0];

        if (ambiguous === undefined) {
          return {
            outcome: "STATE_INVALID",
          };
        }

        if (resolution === "CONFIRMED_NOT_EXECUTED") {
          const [execution] = await transaction
            .update(workflowStepExecutions)
            .set({
              status: "FAILED",
              checkpoint: "FINALIZED",
              errorCode: "WORKFLOW_AMBIGUITY_NOT_EXECUTED",
              completedAt: now,
              recoveryUpdatedAt: now,
            })
            .where(
              and(
                eq(workflowStepExecutions.id, ambiguous.execution.id),
                eq(workflowStepExecutions.status, "AMBIGUOUS"),
                eq(workflowStepExecutions.checkpoint, "AMBIGUOUS"),
              ),
            )
            .returning();

          if (execution === undefined) {
            throw ambiguityStateChanged();
          }

          const [step] = await transaction
            .update(workflowSteps)
            .set({
              status: "FAILED",
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(workflowSteps.id, ambiguous.step.id),
                eq(workflowSteps.status, "RECOVERY_REQUIRED"),
              ),
            )
            .returning();

          if (step === undefined) {
            throw ambiguityStateChanged();
          }

          await transaction
            .update(workflowSteps)
            .set({
              status: "SKIPPED",
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(workflowSteps.workflowId, workflowId),
                inArray(workflowSteps.status, ["READY", "BLOCKED"]),
              ),
            );

          const [resolvedWorkflow] = await transaction
            .update(workflows)
            .set({
              status: "FAILED",
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(workflows.id, workflowId),
                eq(workflows.actorId, actorId),
                eq(workflows.status, "RECOVERY_REQUIRED"),
              ),
            )
            .returning();

          if (resolvedWorkflow === undefined) {
            throw ambiguityStateChanged();
          }

          return {
            outcome: "RESOLVED",
            workflow: resolvedWorkflow,
          };
        }

        const remainingSteps = await transaction
          .select()
          .from(workflowSteps)
          .where(eq(workflowSteps.workflowId, workflowId));

        if (
          remainingSteps.some(
            (step) =>
              step.id !== ambiguous.step.id &&
              payloadReferencesStep(step.payload, ambiguous.step.stepKey),
          )
        ) {
          return {
            outcome: "RESULT_REQUIRED",
          };
        }

        const [execution] = await transaction
          .update(workflowStepExecutions)
          .set({
            status: "SUCCEEDED",
            checkpoint: "FINALIZED",
            errorCode: null,
            completedAt: now,
            recoveryUpdatedAt: now,
          })
          .where(
            and(
              eq(workflowStepExecutions.id, ambiguous.execution.id),
              eq(workflowStepExecutions.status, "AMBIGUOUS"),
              eq(workflowStepExecutions.checkpoint, "AMBIGUOUS"),
            ),
          )
          .returning();

        if (execution === undefined) {
          throw ambiguityStateChanged();
        }

        const [step] = await transaction
          .update(workflowSteps)
          .set({
            status: "SUCCEEDED",
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(workflowSteps.id, ambiguous.step.id),
              eq(workflowSteps.status, "RECOVERY_REQUIRED"),
            ),
          )
          .returning();

        if (step === undefined) {
          throw ambiguityStateChanged();
        }

        const [runningWorkflow] = await transaction
          .update(workflows)
          .set({
            status: "RUNNING",
            completedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(workflows.id, workflowId),
              eq(workflows.actorId, actorId),
              eq(workflows.status, "RECOVERY_REQUIRED"),
            ),
          )
          .returning();

        if (runningWorkflow === undefined) {
          throw ambiguityStateChanged();
        }

        await unlockSatisfiedSteps(transaction, workflowId, now);

        const remaining = await transaction
          .select({
            id: workflowSteps.id,
          })
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.workflowId, workflowId),
              sql`${workflowSteps.status} <> 'SUCCEEDED'`,
            ),
          )
          .limit(1);

        if (remaining.length === 0) {
          const [completed] = await transaction
            .update(workflows)
            .set({
              status: "COMPLETED",
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(workflows.id, workflowId),
                eq(workflows.actorId, actorId),
                eq(workflows.status, "RUNNING"),
              ),
            )
            .returning();

          if (completed === undefined) {
            throw ambiguityStateChanged();
          }

          return {
            outcome: "RESOLVED",
            workflow: completed,
          };
        }

        return {
          outcome: "RESOLVED",
          workflow: runningWorkflow,
        };
      });
    } catch (error) {
      if (error instanceof WorkflowAmbiguityStateChangedError) {
        return {
          outcome: "STATE_INVALID",
        };
      }

      throw error;
    }
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
        .set({
          status: "FAILED",
          checkpoint: "FINALIZED",
          errorCode,
          completedAt: now,
        })
        .where(eq(workflowStepExecutions.id, executionId));

      await transaction
        .update(workflowSteps)
        .set({
          status: "FAILED",
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(workflowSteps.id, stepId));

      await transaction
        .update(workflowSteps)
        .set({
          status: "SKIPPED",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(workflowSteps.workflowId, workflowId),
            inArray(workflowSteps.status, ["READY", "BLOCKED"]),
          ),
        );

      await transaction
        .update(workflows)
        .set({
          status: "FAILED",
          completedAt: now,
          updatedAt: now,
        })
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
        .set({
          status: "AWAITING_APPROVAL",
          checkpoint: "AWAITING_APPROVAL",
          approvalId,
          recoveryUpdatedAt: now,
        })
        .where(eq(workflowStepExecutions.id, executionId));

      await transaction
        .update(workflowSteps)
        .set({
          status: "AWAITING_APPROVAL",
          updatedAt: now,
        })
        .where(eq(workflowSteps.id, stepId));

      await transaction
        .update(workflows)
        .set({
          status: "AWAITING_APPROVAL",
          updatedAt: now,
        })
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
        .set({
          status: "RUNNING",
          updatedAt: now,
        })
        .where(eq(workflows.id, row.workflow.id));

      await transaction
        .update(workflowSteps)
        .set({
          status: "RUNNING",
          updatedAt: now,
        })
        .where(eq(workflowSteps.id, row.step.id));

      await transaction
        .update(workflowStepExecutions)
        .set({
          status: "RUNNING",
          checkpoint: "PREPARED",
          recoveryUpdatedAt: now,
        })
        .where(eq(workflowStepExecutions.id, row.execution.id));

      return row;
    });
  }

  public async canResumeApproval(actorId: string, approvalId: string) {
    const [row] = await this.database.db
      .select({
        id: workflowStepExecutions.id,
      })
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

class WorkflowAmbiguityStateChangedError extends Error {
  public constructor() {
    super("Workflow ambiguity state changed during resolution");
    this.name = "WorkflowAmbiguityStateChangedError";
  }
}

function ambiguityStateChanged(): WorkflowAmbiguityStateChangedError {
  return new WorkflowAmbiguityStateChangedError();
}

type WorkflowTransaction = Parameters<
  Parameters<DatabaseClient["db"]["transaction"]>[0]
>[0];

async function unlockSatisfiedSteps(
  transaction: WorkflowTransaction,
  workflowId: string,
  now: Date,
): Promise<void> {
  await transaction.execute(
    sql`
      update workflow_steps candidate
      set
        status = 'READY',
        updated_at = ${now}
      where
        candidate.workflow_id = ${workflowId}
        and candidate.status = 'BLOCKED'
        and not exists (
          select 1
          from workflow_step_dependencies dependency
          join workflow_steps required
            on required.id = dependency.depends_on_step_id
          where
            dependency.step_id = candidate.id
            and required.status <> 'SUCCEEDED'
        )
    `,
  );
}

function payloadReferencesStep(payload: unknown, stepKey: string): boolean {
  const root = object(payload);
  const tool = object(root?.tool);
  const input = object(tool?.input);

  if (input === undefined) return false;

  return Object.values(input).some((value) => {
    const reference = object(value);

    if (reference === undefined) return false;

    return (
      reference.fromStep === stepKey &&
      typeof reference.field === "string" &&
      reference.field.length > 0
    );
  });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safePayload(step: WorkflowStep): Record<string, unknown> {
  switch (step.kind) {
    case "tool":
      return {
        tool: step.tool,
      };

    case "memory_read":
      return {
        memoryKind: step.memoryKind,
      };

    case "memory_search":
    case "knowledge_search":
      return {
        query: step.query,
      };
  }
}

function requireStepId(
  byKey: ReadonlyMap<string, string>,
  key: string,
): string {
  const id = byKey.get(key);

  if (id === undefined) {
    throw new Error("Workflow step mapping failed");
  }

  return id;
}
