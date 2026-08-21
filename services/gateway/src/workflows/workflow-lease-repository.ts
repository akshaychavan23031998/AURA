import { and, eq, inArray, lte, sql } from "drizzle-orm";

import type { DatabaseClient } from "../db/client.js";
import { workflowWorkerLeases, workflows } from "../db/schema.js";

export interface WorkflowLease {
  readonly workflowId: string;
  readonly actorId: string;
  readonly owner: string;
  readonly generation: number;
  readonly expiresAt: Date;
  readonly workflowStatus: "READY" | "RUNNING";
}

export class WorkflowLeaseRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public acquireNext(owner: string, now: Date, leaseMs: number) {
    return this.database.db.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select({
          id: workflows.id,
          actorId: workflows.actorId,
          status: workflows.status,
        })
        .from(workflows)
        .leftJoin(
          workflowWorkerLeases,
          eq(workflowWorkerLeases.workflowId, workflows.id),
        )
        .where(
          and(
            inArray(workflows.status, ["READY", "RUNNING"]),
            sql`${workflows.executionRequestedAt} is not null`,
            sql`(${workflowWorkerLeases.workflowId} is null or ${workflowWorkerLeases.expiresAt} <= ${now})`,
          ),
        )
        .orderBy(workflows.createdAt, workflows.id)
        .limit(1)
        .for("update", { of: workflows, skipLocked: true });
      if (candidate === undefined) return undefined;
      const expiresAt = new Date(now.getTime() + leaseMs);
      const [lease] = await transaction
        .insert(workflowWorkerLeases)
        .values({
          workflowId: candidate.id,
          leaseOwner: owner,
          leaseGeneration: 1,
          leasedAt: now,
          heartbeatAt: now,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: workflowWorkerLeases.workflowId,
          set: {
            leaseOwner: owner,
            leaseGeneration: sql`${workflowWorkerLeases.leaseGeneration} + 1`,
            leasedAt: now,
            heartbeatAt: now,
            expiresAt,
          },
          setWhere: lte(workflowWorkerLeases.expiresAt, now),
        })
        .returning();
      if (lease === undefined) return undefined;
      return {
        workflowId: candidate.id,
        actorId: candidate.actorId,
        owner: lease.leaseOwner,
        generation: lease.leaseGeneration,
        expiresAt: lease.expiresAt,
        workflowStatus: candidate.status as "READY" | "RUNNING",
      } satisfies WorkflowLease;
    });
  }

  public async assertOwned(
    lease: WorkflowLease,
    now: Date = new Date(),
  ): Promise<boolean> {
    const [row] = await this.database.db
      .select({ workflowId: workflowWorkerLeases.workflowId })
      .from(workflowWorkerLeases)
      .where(
        and(
          eq(workflowWorkerLeases.workflowId, lease.workflowId),
          eq(workflowWorkerLeases.leaseOwner, lease.owner),
          eq(workflowWorkerLeases.leaseGeneration, lease.generation),
          sql`${workflowWorkerLeases.expiresAt} > ${now}`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  public async heartbeat(
    lease: WorkflowLease,
    now: Date,
    leaseMs: number,
  ): Promise<WorkflowLease | undefined> {
    const expiresAt = new Date(now.getTime() + leaseMs);
    const [row] = await this.database.db
      .update(workflowWorkerLeases)
      .set({ heartbeatAt: now, expiresAt })
      .where(
        and(
          eq(workflowWorkerLeases.workflowId, lease.workflowId),
          eq(workflowWorkerLeases.leaseOwner, lease.owner),
          eq(workflowWorkerLeases.leaseGeneration, lease.generation),
          sql`${workflowWorkerLeases.expiresAt} > ${now}`,
        ),
      )
      .returning();
    return row === undefined ? undefined : { ...lease, expiresAt };
  }

  public async release(lease: WorkflowLease, now: Date): Promise<boolean> {
    const [row] = await this.database.db
      .update(workflowWorkerLeases)
      .set({ heartbeatAt: now, expiresAt: now })
      .where(
        and(
          eq(workflowWorkerLeases.workflowId, lease.workflowId),
          eq(workflowWorkerLeases.leaseOwner, lease.owner),
          eq(workflowWorkerLeases.leaseGeneration, lease.generation),
        ),
      )
      .returning({ workflowId: workflowWorkerLeases.workflowId });
    return row !== undefined;
  }
}
