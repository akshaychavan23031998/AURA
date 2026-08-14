import { performance } from "node:perf_hooks";

import type { ApprovalRepository } from "../approvals/approval-repository.js";
import type {
  AgentRequest,
  AgentResult,
  AgentServiceClient,
} from "../clients/agent/agent-service-client.js";
import type {
  ToolExecutionResult,
  ToolPreparation,
  ToolServiceClient,
  TrustedToolContext,
} from "../clients/tools/tool-service-client.js";
import { AppError } from "../errors/app-error.js";
import type { TurnExecutionPhase } from "../voice/cancellation.js";

export interface AgentRunRequest {
  readonly message: string;
  readonly conversationId?: string;
  readonly locale?: string;
}
export interface CompletedAgentRunResult {
  readonly status: "completed";
  readonly response: { readonly text: string };
  readonly steps: 1 | 2;
}
export interface ApprovalRequiredAgentRunResult {
  readonly status: "approval_required";
  readonly approval: {
    readonly approvalId: string;
    readonly title: string;
    readonly preview: string;
    readonly expiresAt: string;
  };
}
export type AgentRunResult =
  CompletedAgentRunResult | ApprovalRequiredAgentRunResult;
export interface OrchestrationLogger {
  info(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}
export interface AgentToolOrchestratorDependencies {
  readonly agentClient: AgentServiceClient;
  readonly toolClient: ToolServiceClient;
  readonly approvals?: Pick<ApprovalRepository, "create">;
  readonly approvalTtlSeconds?: number;
  readonly logger?: OrchestrationLogger;
}
export interface OrchestrationControl {
  readonly signal?: AbortSignal;
  readonly onPhaseChange?: (phase: TurnExecutionPhase) => void;
  readonly onToolDispatched?: () => void;
  readonly onToolCompleted?: () => void;
}
type ToolPlan = Extract<AgentResult["plan"], { readonly type: "tool" }>;

export class AgentToolOrchestrator {
  public constructor(
    private readonly dependencies: AgentToolOrchestratorDependencies,
  ) {}

  public async run(
    request: AgentRunRequest,
    requestId: string,
    authorizationContext: TrustedToolContext,
    control: OrchestrationControl = {},
  ): Promise<AgentRunResult> {
    const startedAt = performance.now();
    control.onPhaseChange?.("AGENT_INITIAL");
    const initial = await this.respond(request, requestId, control.signal);
    if (initial.plan.type === "respond") {
      this.logCompleted(requestId, "respond", 1, startedAt);
      return completed(initial.response, 1);
    }
    return this.executeToolOrSuspend(
      request,
      initial.plan,
      requestId,
      authorizationContext,
      startedAt,
      control,
    );
  }

  public async resumeApproved(
    request: AgentRunRequest,
    tool: { readonly name: string; readonly input: unknown },
    authorizationContext: TrustedToolContext,
    requestId: string,
  ): Promise<CompletedAgentRunResult> {
    const startedAt = performance.now();
    const result = await this.dependencies.toolClient.execute(
      { tool: tool.name, input: tool.input },
      authorizationContext,
      requestId,
    );
    return this.finalize(request, result, requestId, startedAt, {});
  }

  private async executeToolOrSuspend(
    request: AgentRunRequest,
    plan: ToolPlan,
    requestId: string,
    context: TrustedToolContext,
    startedAt: number,
    control: OrchestrationControl,
  ): Promise<AgentRunResult> {
    const proposal = plan.tool;
    control.signal?.throwIfAborted();
    const preparation = await this.dependencies.toolClient.prepare?.(
      { tool: proposal.name, input: proposal.input },
      requestId,
    );
    if (preparation?.approvalPolicy === "REQUIRED")
      return this.suspend(request, preparation, requestId, context);
    control.onPhaseChange?.("TOOL_EXECUTION");
    control.onToolDispatched?.();
    const result = await this.dependencies.toolClient.execute(
      { tool: proposal.name, input: proposal.input },
      context,
      requestId,
    );
    control.onToolCompleted?.();
    control.signal?.throwIfAborted();
    return this.finalize(request, result, requestId, startedAt, control);
  }

  private async suspend(
    request: AgentRunRequest,
    preparation: ToolPreparation,
    requestId: string,
    context: TrustedToolContext,
  ): Promise<ApprovalRequiredAgentRunResult> {
    const approvals = this.dependencies.approvals;
    if (approvals === undefined)
      throw new AppError({
        code: "INTERNAL_SERVER_ERROR",
        httpStatus: 500,
        message: "Approval service unavailable",
      });
    const row = await approvals.create({
      actorId: context.actorId,
      toolName: preparation.tool,
      toolVersion: preparation.version,
      inputDigest: preparation.inputDigest,
      input: preparation.input,
      request: { kind: "agent_tool", request, originalRequestId: requestId },
      title: preparation.title,
      preview: preparation.preview,
      expiresAt: new Date(
        Date.now() + (this.dependencies.approvalTtlSeconds ?? 300) * 1_000,
      ),
    });
    return {
      status: "approval_required",
      approval: {
        approvalId: row.id,
        title: row.title,
        preview: row.preview,
        expiresAt: row.expiresAt.toISOString(),
      },
    };
  }

  private async finalize(
    request: AgentRunRequest,
    toolResult: ToolExecutionResult,
    requestId: string,
    startedAt: number,
    control: OrchestrationControl,
  ): Promise<CompletedAgentRunResult> {
    let final: AgentResult;
    try {
      control.onPhaseChange?.("AGENT_FINALIZATION");
      final = await this.respond(
        {
          ...request,
          toolResult: {
            tool: toolResult.tool,
            status: "success",
            data: toolResult.data,
          },
        },
        requestId,
        control.signal,
      );
    } catch (error) {
      this.dependencies.logger?.error(
        {
          requestId,
          phase: "agent-finalization",
          toolName: toolResult.tool,
          toolExecutionSucceeded: true,
          duration: performance.now() - startedAt,
          err: error,
        },
        "Agent finalization failed after successful tool execution",
      );
      throw new AppError({
        code: "AGENT_FINALIZATION_FAILED",
        httpStatus: 502,
        message:
          "The action may have completed, but the final agent response could not be generated",
        cause: error,
      });
    }
    if (final.plan.type === "tool")
      throw new AppError({
        code: "ORCHESTRATION_STEP_LIMIT_EXCEEDED",
        httpStatus: 500,
        message: "Agent orchestration step limit exceeded",
      });
    this.logCompleted(requestId, "tool", 2, startedAt, toolResult.tool);
    return completed(final.response, 2);
  }

  private logCompleted(
    requestId: string,
    planType: "respond" | "tool",
    step: 1 | 2,
    startedAt: number,
    toolName?: string,
  ): void {
    this.dependencies.logger?.info(
      {
        requestId,
        phase: "completed",
        planType,
        ...(toolName === undefined ? {} : { toolName }),
        step,
        outcome: "completed",
        duration: performance.now() - startedAt,
      },
      "Agent orchestration completed",
    );
  }
  private respond(
    request: AgentRequest,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    return signal === undefined
      ? this.dependencies.agentClient.respond(request, requestId)
      : this.dependencies.agentClient.respond(request, requestId, signal);
  }
}

function completed(text: string, steps: 1 | 2): CompletedAgentRunResult {
  return {
    status: "completed",
    response: { text },
    steps,
  };
}
