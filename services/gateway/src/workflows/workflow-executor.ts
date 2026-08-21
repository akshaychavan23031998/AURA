import type { ApprovalRepository } from "../approvals/approval-repository.js";
import type {
  ToolServiceClient,
  TrustedToolContext,
} from "../clients/tools/tool-service-client.js";
import { AppError } from "../errors/app-error.js";
import type { KnowledgeStore } from "../knowledge/knowledge-service.js";
import type { MemoryStore } from "../memory/memory-service.js";
import type { WorkflowRepository } from "./workflow-repository.js";
import { resolveWorkflowToolInput } from "./workflow-references.js";
import type { WorkflowStore, WorkflowView } from "./workflow-service.js";

export const WORKFLOW_RESULT_MAX_BYTES = 65_536;

export interface WorkflowExecutionFence {
  assertOwned(): Promise<void>;
}

export interface WorkflowRunner {
  run(
    actorId: string,
    workflowId: string,
    context: TrustedToolContext,
    requestId: string,
    fence?: WorkflowExecutionFence,
  ): Promise<WorkflowView>;
  resumeApproved(
    actorId: string,
    approvalId: string,
    tool: { name: string; input: unknown },
    context: TrustedToolContext,
    requestId: string,
  ): Promise<WorkflowView>;
  rejectApproval(
    actorId: string,
    approvalId: string,
    errorCode: string,
  ): Promise<void>;
  canResumeApproval(actorId: string, approvalId: string): Promise<boolean>;
  recover(
    actorId: string,
    workflowId: string,
    context: TrustedToolContext,
    requestId: string,
    fence?: WorkflowExecutionFence,
  ): Promise<WorkflowView>;
}

export class WorkflowExecutor implements WorkflowRunner {
  public constructor(
    private readonly repository: WorkflowRepository,
    private readonly workflows: WorkflowStore,
    private readonly tools: ToolServiceClient,
    private readonly approvals: Pick<ApprovalRepository, "create"> &
      Partial<Pick<ApprovalRepository, "findOwned" | "findForWorkflowStep">>,
    private readonly memories: MemoryStore,
    private readonly knowledge: Pick<KnowledgeStore, "searchOwned">,
    private readonly approvalTtlSeconds = 300,
    private readonly recoveryStaleMs = 60_000,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async run(
    actorId: string,
    workflowId: string,
    context: TrustedToolContext,
    requestId: string,
    fence?: WorkflowExecutionFence,
  ) {
    await fence?.assertOwned();
    const requested = await this.repository.requestExecutionOwned(
      actorId,
      workflowId,
      context.grantedPermissions,
      this.clock(),
    );
    if (requested === undefined) throw notFound();
    await fence?.assertOwned();
    const started = await this.repository.startOwned(
      actorId,
      workflowId,
      new Date(),
    );
    if (started === undefined) throw notFound();
    if (!started.claimed) return this.workflows.getOwned(actorId, workflowId);
    return this.executeLoop(actorId, workflowId, context, requestId, fence);
  }

  public async resumeApproved(
    actorId: string,
    approvalId: string,
    tool: { name: string; input: unknown },
    context: TrustedToolContext,
    requestId: string,
  ) {
    const resumed = await this.repository.resumeApproval(
      actorId,
      approvalId,
      new Date(),
    );
    if (resumed === undefined) throw stateInvalid();
    let idempotency: "IDEMPOTENT" | "NON_IDEMPOTENT" = "NON_IDEMPOTENT";
    let crossedDispatchBoundary = false;
    try {
      const preparation = await this.tools.prepare?.(
        { tool: tool.name, input: tool.input },
        context,
        requestId,
      );
      idempotency = preparation?.idempotency ?? "NON_IDEMPOTENT";
      if (
        (await this.repository.checkpoint(
          resumed.execution.id,
          ["PREPARED"],
          "DISPATCH_PENDING",
          this.clock(),
        )) === undefined
      )
        throw stateInvalid();
      crossedDispatchBoundary = true;
      const result = await this.tools.execute(
        { tool: tool.name, input: tool.input },
        context,
        requestId,
      );
      await this.persistSuccess(
        resumed.workflow.id,
        resumed.step.id,
        resumed.execution.id,
        result.data,
      );
    } catch (error) {
      if (crossedDispatchBoundary && idempotency === "NON_IDEMPOTENT") {
        await this.repository.markAmbiguous(
          resumed.workflow.id,
          resumed.step.id,
          resumed.execution.id,
          this.clock(),
        );
        return this.workflows.getOwned(actorId, resumed.workflow.id);
      }
      await this.repository.fail(
        resumed.workflow.id,
        resumed.step.id,
        resumed.execution.id,
        safeCode(error),
        new Date(),
      );
      return this.workflows.getOwned(actorId, resumed.workflow.id);
    }
    return this.executeLoop(actorId, resumed.workflow.id, context, requestId);
  }

  public async rejectApproval(
    actorId: string,
    approvalId: string,
    errorCode: string,
  ): Promise<void> {
    const resumed = await this.repository.resumeApproval(
      actorId,
      approvalId,
      new Date(),
    );
    if (resumed !== undefined)
      await this.repository.fail(
        resumed.workflow.id,
        resumed.step.id,
        resumed.execution.id,
        errorCode,
        new Date(),
      );
  }

  public canResumeApproval(actorId: string, approvalId: string) {
    return this.repository.canResumeApproval(actorId, approvalId);
  }

  public async recover(
    actorId: string,
    workflowId: string,
    context: TrustedToolContext,
    requestId: string,
    fence?: WorkflowExecutionFence,
  ): Promise<WorkflowView> {
    await fence?.assertOwned();
    const now = this.clock();
    const graph = await this.repository.getOwned(actorId, workflowId);
    if (graph === undefined) throw notFound();
    if (graph.workflow.status === "RECOVERY_REQUIRED")
      return this.workflows.getOwned(actorId, workflowId);
    if (graph.workflow.status === "AWAITING_APPROVAL") {
      const execution = graph.executions.find(
        (item) => item.status === "AWAITING_APPROVAL",
      );
      if (execution?.approvalId === null || execution?.approvalId === undefined)
        throw recoveryNotAllowed();
      const approval = await this.approvals.findOwned?.(
        execution.approvalId,
        actorId,
      );
      if (approval === undefined) throw recoveryNotAllowed();
      if (approval.status === "PENDING" && approval.expiresAt > now)
        return this.workflows.getOwned(actorId, workflowId);
      if (approval.status === "CONSUMED")
        return this.resumeApproved(
          actorId,
          approval.id,
          { name: approval.toolName, input: approval.inputEnvelope },
          context,
          requestId,
        );
      await this.rejectApproval(
        actorId,
        approval.id,
        approval.expiresAt <= now ? "APPROVAL_EXPIRED" : "APPROVAL_REJECTED",
      );
      return this.workflows.getOwned(actorId, workflowId);
    }
    if (graph.workflow.status !== "RUNNING") throw recoveryNotAllowed();
    const claimed = await this.repository.claimRecoveryOwned(
      actorId,
      workflowId,
      new Date(now.getTime() - this.recoveryStaleMs),
      now,
    );
    if (claimed === undefined) throw recoveryInProgress();
    await this.executeClaim(
      actorId,
      workflowId,
      claimed,
      context,
      requestId,
      true,
      fence,
    );
    const current = await this.workflows.getOwned(actorId, workflowId);
    return current.status === "RUNNING"
      ? this.executeLoop(actorId, workflowId, context, requestId, fence)
      : current;
  }

  private async executeLoop(
    actorId: string,
    workflowId: string,
    context: TrustedToolContext,
    requestId: string,
    fence?: WorkflowExecutionFence,
  ): Promise<WorkflowView> {
    for (let count = 0; count < 8; count += 1) {
      await fence?.assertOwned();
      const claimed = await this.repository.claimNext(workflowId, new Date());
      if (claimed === undefined)
        return this.workflows.getOwned(actorId, workflowId);
      await this.executeClaim(
        actorId,
        workflowId,
        claimed,
        context,
        requestId,
        false,
        fence,
      );
      const current = await this.workflows.getOwned(actorId, workflowId);
      if (current.status !== "RUNNING") return current;
    }
    return this.workflows.getOwned(actorId, workflowId);
  }

  private async executeClaim(
    actorId: string,
    workflowId: string,
    claimed: Awaited<ReturnType<WorkflowRepository["claimNext"]>> & {},
    context: TrustedToolContext,
    requestId: string,
    recovering: boolean,
    fence?: WorkflowExecutionFence,
  ): Promise<void> {
    let unsafeDispatch = false;
    try {
      if (recovering && claimed.execution.errorCode !== null) {
        await this.repository.fail(
          workflowId,
          claimed.step.id,
          claimed.execution.id,
          claimed.execution.errorCode,
          this.clock(),
        );
        return;
      }
      if (recovering && claimed.execution.result !== null) {
        await this.persistSuccess(
          workflowId,
          claimed.step.id,
          claimed.execution.id,
          claimed.execution.result,
          true,
        );
        return;
      }
      const payload = claimed.step.payload as Record<string, unknown>;
      if (claimed.step.kind === "tool") {
        const tool = payload.tool as { name: string; input: unknown };
        const graph = await this.repository.getForResolution(workflowId);
        if (graph === undefined) throw stateInvalid();
        const resolvedInput = resolveWorkflowToolInput(
          graph,
          claimed.step.id,
          tool.name,
          tool.input as Record<string, unknown>,
        );
        const preparation = await this.tools.prepare?.(
          { tool: tool.name, input: resolvedInput },
          context,
          requestId,
        );
        if (preparation === undefined) throw stateInvalid();
        if (
          recovering &&
          ["DISPATCH_PENDING", "DISPATCHED"].includes(
            claimed.execution.checkpoint,
          ) &&
          preparation.idempotency === "NON_IDEMPOTENT"
        ) {
          await this.repository.markAmbiguous(
            workflowId,
            claimed.step.id,
            claimed.execution.id,
            this.clock(),
          );
          return;
        }
        if (["CLAIMED", "PREPARED"].includes(claimed.execution.checkpoint))
          requireCheckpoint(
            await this.repository.checkpoint(
              claimed.execution.id,
              [claimed.execution.checkpoint as "CLAIMED" | "PREPARED"],
              "PREPARED",
              this.clock(),
            ),
          );
        if (preparation?.approvalPolicy === "REQUIRED") {
          const existing = await this.approvals.findForWorkflowStep?.(
            actorId,
            workflowId,
            claimed.step.id,
          );
          const approval =
            existing ??
            (await this.approvals.create({
              actorId,
              toolName: preparation.tool,
              toolVersion: preparation.version,
              inputDigest: preparation.inputDigest,
              input: preparation.input,
              request: {
                kind: "workflow_tool",
                workflowId,
                stepId: claimed.step.id,
                originalRequestId: requestId,
              },
              title: preparation.title,
              preview: preparation.preview,
              expiresAt: new Date(Date.now() + this.approvalTtlSeconds * 1000),
            }));
          await this.repository.awaitApproval(
            workflowId,
            claimed.step.id,
            claimed.execution.id,
            approval.id,
            new Date(),
          );
          return;
        }
        requireCheckpoint(
          await this.repository.checkpoint(
            claimed.execution.id,
            ["PREPARED", "DISPATCH_PENDING", "DISPATCHED"],
            "DISPATCH_PENDING",
            this.clock(),
          ),
        );
        await fence?.assertOwned();
        unsafeDispatch = preparation.idempotency === "NON_IDEMPOTENT";
        const result = await this.tools.execute(
          { tool: tool.name, input: resolvedInput },
          context,
          requestId,
        );
        await fence?.assertOwned();
        await this.persistSuccess(
          workflowId,
          claimed.step.id,
          claimed.execution.id,
          result.data,
        );
      } else if (claimed.step.kind === "memory_read") {
        await this.prepareSafeDispatch(claimed.execution.id);
        await fence?.assertOwned();
        requirePermission(context, "memory.read");
        const memoryKind = payload.memoryKind as
          "preference" | "fact" | "instruction" | "note" | null;
        const result = await this.memories.listOwned(
          actorId,
          memoryKind === null ? { limit: 10 } : { limit: 10, kind: memoryKind },
        );
        await this.persistSuccess(
          workflowId,
          claimed.step.id,
          claimed.execution.id,
          result,
        );
      } else if (claimed.step.kind === "memory_search") {
        await this.prepareSafeDispatch(claimed.execution.id);
        await fence?.assertOwned();
        requirePermission(context, "memory.read");
        if (this.memories.searchOwnedRelevant === undefined)
          throw new Error("Memory search unavailable");
        const result = await this.memories.searchOwnedRelevant(
          actorId,
          String(payload.query),
          requestId,
        );
        await this.persistSuccess(
          workflowId,
          claimed.step.id,
          claimed.execution.id,
          result,
        );
      } else {
        await this.prepareSafeDispatch(claimed.execution.id);
        await fence?.assertOwned();
        requirePermission(context, "knowledge.read");
        const result = await this.knowledge.searchOwned(
          actorId,
          String(payload.query),
          requestId,
        );
        await this.persistSuccess(
          workflowId,
          claimed.step.id,
          claimed.execution.id,
          result,
        );
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "WORKFLOW_LEASE_LOST")
        return;
      if (unsafeDispatch) {
        await this.repository.markAmbiguous(
          workflowId,
          claimed.step.id,
          claimed.execution.id,
          this.clock(),
        );
        return;
      }
      await this.repository.fail(
        workflowId,
        claimed.step.id,
        claimed.execution.id,
        safeCode(error),
        new Date(),
      );
      return;
    }
  }

  private async prepareSafeDispatch(executionId: string): Promise<void> {
    requireCheckpoint(
      await this.repository.checkpoint(
        executionId,
        ["CLAIMED", "PREPARED"],
        "PREPARED",
        this.clock(),
      ),
    );
    requireCheckpoint(
      await this.repository.checkpoint(
        executionId,
        ["PREPARED", "DISPATCH_PENDING", "DISPATCHED"],
        "DISPATCH_PENDING",
        this.clock(),
      ),
    );
  }

  private async persistSuccess(
    workflowId: string,
    stepId: string,
    executionId: string,
    value: unknown,
    alreadyRecorded = false,
  ) {
    const safe = redact(value);
    if (
      Buffer.byteLength(JSON.stringify(safe), "utf8") >
      WORKFLOW_RESULT_MAX_BYTES
    )
      throw new AppError({
        code: "WORKFLOW_RESULT_TOO_LARGE",
        httpStatus: 500,
        message: "Workflow result exceeded its safe limit",
      });
    if (!alreadyRecorded) {
      const recorded = await this.repository.recordDispatchedResult(
        executionId,
        safe,
        this.clock(),
      );
      if (recorded === undefined) throw stateInvalid();
    }
    await this.repository.succeed(
      workflowId,
      stepId,
      executionId,
      safe,
      this.clock(),
    );
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/(token|authorization|cookie|secret|vector|embedding|approval)/i.test(
              key,
            ),
        )
        .map(([key, entry]) => [key, redact(entry)]),
    );
  return value;
}
function requirePermission(
  context: TrustedToolContext,
  permission: "memory.read" | "knowledge.read",
) {
  if (!context.grantedPermissions.includes(permission))
    throw new AppError({
      code: "PERMISSION_DENIED",
      httpStatus: 403,
      message: "Permission denied",
    });
}
function safeCode(error: unknown): string {
  return error instanceof AppError
    ? error.code.slice(0, 64)
    : "WORKFLOW_STEP_FAILED";
}
function notFound() {
  return new AppError({
    code: "WORKFLOW_NOT_FOUND",
    httpStatus: 404,
    message: "Workflow not found",
  });
}
function stateInvalid() {
  return new AppError({
    code: "WORKFLOW_STATE_INVALID",
    httpStatus: 409,
    message: "Workflow state transition is invalid",
  });
}
function recoveryNotAllowed() {
  return new AppError({
    code: "WORKFLOW_RECOVERY_NOT_ALLOWED",
    httpStatus: 409,
    message: "Workflow recovery is not allowed",
  });
}
function recoveryInProgress() {
  return new AppError({
    code: "WORKFLOW_RECOVERY_IN_PROGRESS",
    httpStatus: 409,
    message: "Workflow execution is still in progress",
  });
}
function requireCheckpoint<T>(value: T | undefined): T {
  if (value === undefined) throw stateInvalid();
  return value;
}
