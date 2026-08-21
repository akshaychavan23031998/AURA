import { randomUUID } from "node:crypto";

import type { TrustedToolContext } from "../clients/tools/tool-service-client.js";
import { AppError } from "../errors/app-error.js";
import type {
  WorkflowExecutionFence,
  WorkflowRunner,
} from "./workflow-executor.js";
import type {
  WorkflowLease,
  WorkflowLeaseRepository,
} from "./workflow-lease-repository.js";
import type { WorkflowActorPolicy } from "./workflow-actor-policy.js";

export interface WorkflowWorkerConfig {
  readonly enabled: boolean;
  readonly pollMs: number;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
}

export class WorkflowWorker {
  private stopping = false;
  private readonly owner = `worker-${randomUUID()}`;

  public constructor(
    private readonly config: WorkflowWorkerConfig,
    private readonly leases: WorkflowLeaseRepository,
    private readonly policy: WorkflowActorPolicy,
    private readonly runner: WorkflowRunner,
    private readonly log: {
      info(data: object, message: string): void;
      warn(data: object, message: string): void;
      error(data: object, message: string): void;
    },
    private readonly clock: () => Date = () => new Date(),
    private readonly wait: (milliseconds: number) => Promise<void> = (
      milliseconds,
    ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  public async run(): Promise<void> {
    if (!this.config.enabled) return;
    while (!this.stopping) {
      await this.pollOnce();
      if (!this.stopping) await this.wait(this.config.pollMs);
    }
  }

  public stop(): void {
    this.stopping = true;
  }

  public async pollOnce(): Promise<boolean> {
    if (!this.config.enabled || this.stopping) return false;
    const lease = await this.leases.acquireNext(
      this.owner,
      this.clock(),
      this.config.leaseMs,
    );
    if (lease === undefined) return false;
    await this.process(lease);
    return true;
  }

  private async process(initialLease: WorkflowLease): Promise<void> {
    let lease = initialLease;
    let lost = false;
    const heartbeat = setInterval(() => {
      void this.leases
        .heartbeat(lease, this.clock(), this.config.leaseMs)
        .then((renewed) => {
          if (renewed === undefined) lost = true;
          else lease = renewed;
        })
        .catch(() => {
          lost = true;
        });
    }, this.config.heartbeatMs);
    const fence: WorkflowExecutionFence = {
      assertOwned: async () => {
        if (lost || !(await this.leases.assertOwned(lease, this.clock()))) {
          lost = true;
          throw leaseLost();
        }
      },
    };
    try {
      const context = await this.policy.resolve(
        lease.actorId,
        lease.workflowId,
      );
      if (context === undefined) throw new Error("Workflow actor unavailable");
      await fence.assertOwned();
      const requestId = `workflow-worker-${randomUUID()}`;
      if (lease.workflowStatus === "READY")
        await this.runner.run(
          lease.actorId,
          lease.workflowId,
          context satisfies TrustedToolContext,
          requestId,
          fence,
        );
      else
        await this.runner.recover(
          lease.actorId,
          lease.workflowId,
          context satisfies TrustedToolContext,
          requestId,
          fence,
        );
      this.log.info(
        {
          workflowId: lease.workflowId,
          leaseGeneration: lease.generation,
          outcome: "processed",
        },
        "Workflow worker processed lease",
      );
    } catch (error) {
      this.log.warn(
        {
          workflowId: lease.workflowId,
          leaseGeneration: lease.generation,
          outcome: lost ? "lease_lost" : "failed",
        },
        "Workflow worker stopped processing lease",
      );
      if (
        !lost &&
        error instanceof AppError &&
        error.code === "WORKFLOW_RECOVERY_IN_PROGRESS"
      )
        return;
    } finally {
      clearInterval(heartbeat);
      if (!lost) await this.leases.release(lease, this.clock());
    }
  }
}

function leaseLost() {
  return new AppError({
    code: "WORKFLOW_LEASE_LOST",
    httpStatus: 409,
    message: "Workflow execution ownership was lost",
  });
}
