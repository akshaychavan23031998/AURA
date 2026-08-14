import { performance } from "node:perf_hooks";

import type {
  AgentRequest,
  AgentResult,
  AgentServiceClient,
} from "../clients/agent/agent-service-client.js";
import type {
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

export interface AgentRunResult {
  readonly status: "completed";
  readonly response: { readonly text: string };
  readonly steps: 1 | 2;
}

export interface OrchestrationLogger {
  info(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

export interface AgentToolOrchestratorDependencies {
  readonly agentClient: AgentServiceClient;
  readonly toolClient: ToolServiceClient;
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

    return this.executeToolAndFinalize(
      request,
      initial.plan,
      requestId,
      authorizationContext,
      startedAt,
      control,
    );
  }

  private async executeToolAndFinalize(
    request: AgentRunRequest,
    plan: ToolPlan,
    requestId: string,
    authorizationContext: TrustedToolContext,
    startedAt: number,
    control: OrchestrationControl,
  ): Promise<AgentRunResult> {
    const proposal = plan.tool;
    control.signal?.throwIfAborted();
    control.onPhaseChange?.("TOOL_EXECUTION");
    control.onToolDispatched?.();
    const toolResult = await this.dependencies.toolClient.execute(
      { tool: proposal.name, input: proposal.input },
      authorizationContext,
      requestId,
    );
    control.onToolCompleted?.();
    control.signal?.throwIfAborted();

    let final: AgentResult;
    try {
      const continuation: AgentRequest = {
        ...request,
        toolResult: {
          tool: toolResult.tool,
          status: "success",
          data: toolResult.data,
        },
      };
      control.onPhaseChange?.("AGENT_FINALIZATION");
      final = await this.respond(continuation, requestId, control.signal);
    } catch (error) {
      this.dependencies.logger?.error(
        {
          requestId,
          phase: "agent-finalization",
          planType: "tool",
          toolName: proposal.name,
          step: 2,
          toolExecutionSucceeded: true,
          finalizationStatus: "failed",
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

    if (final.plan.type === "tool") {
      this.dependencies.logger?.error(
        {
          requestId,
          phase: "step-limit",
          planType: "tool",
          toolName: final.plan.tool.name,
          step: 2,
          toolExecutionSucceeded: true,
          finalizationStatus: "rejected",
          duration: performance.now() - startedAt,
        },
        "Agent proposed a second tool after the orchestration limit",
      );
      throw new AppError({
        code: "ORCHESTRATION_STEP_LIMIT_EXCEEDED",
        httpStatus: 500,
        message: "Agent orchestration step limit exceeded",
      });
    }

    this.logCompleted(requestId, "tool", 2, startedAt, proposal.name);
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

function completed(text: string, steps: 1 | 2): AgentRunResult {
  return { status: "completed", response: { text }, steps };
}
