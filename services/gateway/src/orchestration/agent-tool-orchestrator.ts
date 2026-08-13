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

type ToolPlan = Extract<AgentResult["plan"], { readonly type: "tool" }>;

export class AgentToolOrchestrator {
  public constructor(
    private readonly dependencies: AgentToolOrchestratorDependencies,
  ) {}

  public async run(
    request: AgentRunRequest,
    requestId: string,
    authorizationContext: TrustedToolContext,
  ): Promise<AgentRunResult> {
    const startedAt = performance.now();
    const initial = await this.dependencies.agentClient.respond(
      request,
      requestId,
    );

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
    );
  }

  private async executeToolAndFinalize(
    request: AgentRunRequest,
    plan: ToolPlan,
    requestId: string,
    authorizationContext: TrustedToolContext,
    startedAt: number,
  ): Promise<AgentRunResult> {
    const proposal = plan.tool;
    const toolResult = await this.dependencies.toolClient.execute(
      { tool: proposal.name, input: proposal.input },
      authorizationContext,
      requestId,
    );

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
      final = await this.dependencies.agentClient.respond(
        continuation,
        requestId,
      );
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
}

function completed(text: string, steps: 1 | 2): AgentRunResult {
  return { status: "completed", response: { text }, steps };
}
