import { describe, expect, it, vi } from "vitest";

import type { WorkflowRunner } from "../src/workflows/workflow-executor.js";
import type { WorkflowLeaseRepository } from "../src/workflows/workflow-lease-repository.js";
import type { WorkflowActorPolicy } from "../src/workflows/workflow-actor-policy.js";
import { WorkflowWorker } from "../src/workflows/workflow-worker.js";
import type { WorkflowView } from "../src/workflows/workflow-service.js";

const lease = {
  workflowId: "11111111-1111-4111-8111-111111111111",
  actorId: "22222222-2222-4222-8222-222222222222",
  owner: "worker-test",
  generation: 1,
  expiresAt: new Date("2026-01-01T00:01:00Z"),
  workflowStatus: "READY" as const,
};

function runner() {
  return {
    run: vi
      .fn<WorkflowRunner["run"]>()
      .mockResolvedValue({ status: "COMPLETED" } as WorkflowView),
    recover: vi.fn<WorkflowRunner["recover"]>(),
    resumeApproved: vi.fn<WorkflowRunner["resumeApproved"]>(),
    rejectApproval: vi.fn<WorkflowRunner["rejectApproval"]>(),
    canResumeApproval: vi.fn<WorkflowRunner["canResumeApproval"]>(),
  } satisfies WorkflowRunner;
}

describe("workflow worker", () => {
  it("does no polling when disabled", async () => {
    const leases = { acquireNext: vi.fn() };
    const worker = new WorkflowWorker(
      { enabled: false, pollMs: 1000, leaseMs: 30_000, heartbeatMs: 10_000 },
      leases as unknown as WorkflowLeaseRepository,
      {} as WorkflowActorPolicy,
      runner(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    await expect(worker.pollOnce()).resolves.toBe(false);
    expect(leases.acquireNext).not.toHaveBeenCalled();
  });

  it("executes one leased workflow with reconstructed policy and releases it", async () => {
    const leases = {
      acquireNext: vi.fn().mockResolvedValue(lease),
      assertOwned: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
      heartbeat: vi.fn(),
    };
    const policy = {
      resolve: vi.fn().mockResolvedValue({
        actorId: lease.actorId,
        grantedPermissions: ["workflow.write", "utility.calculator"],
      }),
    };
    const execution = runner();
    const worker = new WorkflowWorker(
      { enabled: true, pollMs: 1000, leaseMs: 30_000, heartbeatMs: 10_000 },
      leases as unknown as WorkflowLeaseRepository,
      policy as unknown as WorkflowActorPolicy,
      execution,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      () => new Date("2026-01-01T00:00:00Z"),
    );
    await expect(worker.pollOnce()).resolves.toBe(true);
    expect(policy.resolve).toHaveBeenCalledWith(
      lease.actorId,
      lease.workflowId,
    );
    const executeRun = execution.run;
    expect(executeRun).toHaveBeenCalledWith(
      lease.actorId,
      lease.workflowId,
      expect.objectContaining({ actorId: lease.actorId }),
      expect.stringMatching(/^workflow-worker-/),
      expect.anything(),
    );
    expect(vi.mocked(executeRun).mock.calls[0]?.[4]).toBeDefined();
    expect(leases.release).toHaveBeenCalledOnce();
  });

  it("stops and does not release as owner after fencing loss", async () => {
    const leases = {
      acquireNext: vi.fn().mockResolvedValue(lease),
      assertOwned: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      release: vi.fn(),
      heartbeat: vi.fn(),
    };
    const execution = runner();
    const executeRun = execution.run;
    vi.mocked(executeRun).mockImplementation(
      async (_actor, _workflow, _context, _request, fence) => {
        await fence!.assertOwned();
        throw new Error("unreachable");
      },
    );
    const worker = new WorkflowWorker(
      { enabled: true, pollMs: 1000, leaseMs: 30_000, heartbeatMs: 10_000 },
      leases as unknown as WorkflowLeaseRepository,
      {
        resolve: vi.fn().mockResolvedValue({
          actorId: lease.actorId,
          grantedPermissions: ["workflow.write"],
        }),
      } as unknown as WorkflowActorPolicy,
      execution,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      () => new Date("2026-01-01T00:00:00Z"),
    );
    await expect(worker.pollOnce()).resolves.toBe(true);
    expect(leases.release).not.toHaveBeenCalled();
  });
});
