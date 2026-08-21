import type { ApprovalRepository } from "../approvals/approval-repository.js";
import type {
  ToolServiceClient,
  TrustedToolContext,
} from "../clients/tools/tool-service-client.js";
import { AppError } from "../errors/app-error.js";
import type { KnowledgeStore } from "../knowledge/knowledge-service.js";
import type { MemoryStore } from "../memory/memory-service.js";
import type { WorkflowRepository } from "./workflow-repository.js";
import type { WorkflowStore, WorkflowView } from "./workflow-service.js";

export const WORKFLOW_RESULT_MAX_BYTES = 65_536;

export interface WorkflowRunner {
  run(
    actorId: string,
    workflowId: string,
    context: TrustedToolContext,
    requestId: string,
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
}

export class WorkflowExecutor implements WorkflowRunner {
  public constructor(
    private readonly repository: WorkflowRepository,
    private readonly workflows: WorkflowStore,
    private readonly tools: ToolServiceClient,
    private readonly approvals: Pick<ApprovalRepository, "create">,
    private readonly memories: MemoryStore,
    private readonly knowledge: Pick<KnowledgeStore, "searchOwned">,
    private readonly approvalTtlSeconds = 300,
  ) {}

  public async run(
    actorId: string,
    workflowId: string,
    context: TrustedToolContext,
    requestId: string,
  ) {
    const started = await this.repository.startOwned(
      actorId,
      workflowId,
      new Date(),
    );
    if (started === undefined) throw notFound();
    if (!started.claimed) return this.workflows.getOwned(actorId, workflowId);
    return this.executeLoop(actorId, workflowId, context, requestId);
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
    try {
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

  private async executeLoop(
    actorId: string,
    workflowId: string,
    context: TrustedToolContext,
    requestId: string,
  ): Promise<WorkflowView> {
    for (let count = 0; count < 8; count += 1) {
      const claimed = await this.repository.claimNext(workflowId, new Date());
      if (claimed === undefined)
        return this.workflows.getOwned(actorId, workflowId);
      try {
        const payload = claimed.step.payload as Record<string, unknown>;
        if (claimed.step.kind === "tool") {
          const tool = payload.tool as { name: string; input: unknown };
          const preparation = await this.tools.prepare?.(
            { tool: tool.name, input: tool.input },
            context,
            requestId,
          );
          if (preparation?.approvalPolicy === "REQUIRED") {
            const approval = await this.approvals.create({
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
            });
            await this.repository.awaitApproval(
              workflowId,
              claimed.step.id,
              claimed.execution.id,
              approval.id,
              new Date(),
            );
            return this.workflows.getOwned(actorId, workflowId);
          }
          const result = await this.tools.execute(
            { tool: tool.name, input: tool.input },
            context,
            requestId,
          );
          await this.persistSuccess(
            workflowId,
            claimed.step.id,
            claimed.execution.id,
            result.data,
          );
        } else if (claimed.step.kind === "memory_read") {
          requirePermission(context, "memory.read");
          const memoryKind = payload.memoryKind as
            "preference" | "fact" | "instruction" | "note" | null;
          const result = await this.memories.listOwned(
            actorId,
            memoryKind === null
              ? { limit: 10 }
              : { limit: 10, kind: memoryKind },
          );
          await this.persistSuccess(
            workflowId,
            claimed.step.id,
            claimed.execution.id,
            result,
          );
        } else if (claimed.step.kind === "memory_search") {
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
        await this.repository.fail(
          workflowId,
          claimed.step.id,
          claimed.execution.id,
          safeCode(error),
          new Date(),
        );
        return this.workflows.getOwned(actorId, workflowId);
      }
    }
    return this.workflows.getOwned(actorId, workflowId);
  }

  private async persistSuccess(
    workflowId: string,
    stepId: string,
    executionId: string,
    value: unknown,
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
    await this.repository.succeed(
      workflowId,
      stepId,
      executionId,
      safe,
      new Date(),
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
