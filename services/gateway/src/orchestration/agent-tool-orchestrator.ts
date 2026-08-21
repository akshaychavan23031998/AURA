import { performance } from "node:perf_hooks";

import type { ApprovalRepository } from "../approvals/approval-repository.js";
import type {
  KnowledgeContextItem,
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
import type {
  MemoryContextView,
  MemoryStore,
} from "../memory/memory-service.js";
import type {
  KnowledgeSearchResultView,
  KnowledgeStore,
} from "../knowledge/knowledge-service.js";
import { normalizeWorkflowPlan } from "../workflows/workflow-plan.js";
import type {
  WorkflowStore,
  WorkflowView,
} from "../workflows/workflow-service.js";

export interface KnowledgeCitation {
  readonly id: string;
  readonly documentId: string;
  readonly chunkId: string;
  readonly title: string;
  readonly ordinal: number;
}

export interface AgentRunRequest {
  readonly message: string;
  readonly conversationId?: string;
  readonly locale?: string;
}
export interface CompletedAgentRunResult {
  readonly status: "completed";
  readonly response: {
    readonly text: string;
    readonly citations?: readonly KnowledgeCitation[];
  };
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
export interface WorkflowCreatedAgentRunResult {
  readonly status: "workflow_created";
  readonly response: { readonly text: string };
  readonly workflow: WorkflowView;
  readonly steps: 1;
}
export type AgentRunResult =
  | CompletedAgentRunResult
  | ApprovalRequiredAgentRunResult
  | WorkflowCreatedAgentRunResult;
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
  readonly memories?: MemoryStore;
  readonly knowledge?: Pick<KnowledgeStore, "searchOwned">;
  readonly workflows?: Pick<WorkflowStore, "create">;
}
export interface OrchestrationControl {
  readonly signal?: AbortSignal;
  readonly onPhaseChange?: (phase: TurnExecutionPhase) => void;
  readonly onToolDispatched?: () => void;
  readonly onToolCompleted?: () => void;
}
type ToolPlan = Extract<AgentResult["plan"], { readonly type: "tool" }>;
type MemoryPlan = Extract<
  AgentResult["plan"],
  {
    readonly type:
      "memory_read" | "memory_search" | "memory_create" | "memory_delete";
  }
>;
type KnowledgePlan = Extract<
  AgentResult["plan"],
  { readonly type: "knowledge_search" }
>;
type WorkflowAgentPlan = Extract<
  AgentResult["plan"],
  { readonly type: "workflow" }
>;

export const KNOWLEDGE_RAG_CONTEXT_MAX_CHARACTERS = 16_000;

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
    if (initial.citationIds != null) throw groundingFailed();
    if (initial.plan.type === "respond") {
      this.logCompleted(requestId, "respond", 1, startedAt);
      return completed(initial.response, 1);
    }
    if (initial.plan.type === "workflow")
      return this.persistWorkflow(
        initial.plan,
        initial.response,
        requestId,
        authorizationContext,
        startedAt,
      );
    if (initial.plan.type === "knowledge_search")
      return this.executeKnowledge(
        request,
        initial.plan,
        requestId,
        authorizationContext,
        startedAt,
        control,
      );
    if (initial.plan.type !== "tool")
      return this.executeMemory(
        request,
        initial.plan,
        requestId,
        authorizationContext,
        startedAt,
        control,
      );
    return this.executeToolOrSuspend(
      request,
      initial.plan,
      requestId,
      authorizationContext,
      startedAt,
      control,
    );
  }

  private async persistWorkflow(
    plan: WorkflowAgentPlan,
    response: string,
    requestId: string,
    context: TrustedToolContext,
    startedAt: number,
  ): Promise<WorkflowCreatedAgentRunResult> {
    if (!context.grantedPermissions.includes("workflow.write"))
      throw new AppError({
        code: "PERMISSION_DENIED",
        httpStatus: 403,
        message: "Permission denied",
      });
    const workflows = this.dependencies.workflows;
    if (workflows === undefined)
      throw new AppError({
        code: "WORKFLOW_STORAGE_FAILED",
        httpStatus: 500,
        message: "Workflow storage operation failed",
      });
    const normalized = normalizeWorkflowPlan(plan);
    const workflow = await workflows.create(context.actorId, normalized);
    this.logCompleted(requestId, "workflow", 1, startedAt);
    return {
      status: "workflow_created",
      response: { text: response },
      workflow,
      steps: 1,
    };
  }

  private async executeKnowledge(
    request: AgentRunRequest,
    plan: KnowledgePlan,
    requestId: string,
    context: TrustedToolContext,
    startedAt: number,
    control: OrchestrationControl,
  ): Promise<CompletedAgentRunResult> {
    const knowledge = this.dependencies.knowledge;
    if (knowledge === undefined)
      throw new AppError({
        code: "KNOWLEDGE_SEARCH_UNAVAILABLE",
        httpStatus: 503,
        message: "Knowledge search is unavailable",
      });
    if (!context.grantedPermissions.includes("knowledge.read"))
      throw new AppError({
        code: "PERMISSION_DENIED",
        httpStatus: 403,
        message: "Permission denied",
      });
    control.signal?.throwIfAborted();
    const retrieved = await knowledge.searchOwned(
      context.actorId,
      plan.query,
      requestId,
    );
    control.signal?.throwIfAborted();
    if (retrieved.length === 0) {
      this.logKnowledge(requestId, startedAt, 0, 0, 0, "no_match");
      return completed(
        "I couldn't find relevant information in your saved knowledge.",
        1,
        [],
      );
    }
    const sources = buildKnowledgeContext(retrieved);
    if (sources.length === 0) throw groundingFailed();
    let final: AgentResult;
    try {
      control.onPhaseChange?.("AGENT_FINALIZATION");
      final = await this.respond(
        {
          ...request,
          knowledgeContext: sources.map((source) => source.context),
        },
        requestId,
        control.signal,
      );
    } catch {
      throw groundingFailed();
    }
    if (final.plan.type !== "respond" || !Array.isArray(final.citationIds))
      throw groundingFailed();
    const citations = resolveCitations(sources, final.citationIds);
    this.logKnowledge(
      requestId,
      startedAt,
      retrieved.length,
      sources.length,
      citations.length,
      "completed",
    );
    return completed(final.response, 2, citations);
  }

  private logKnowledge(
    requestId: string,
    startedAt: number,
    retrievedCount: number,
    contextCount: number,
    citationCount: number,
    outcome: "completed" | "no_match",
  ): void {
    this.dependencies.logger?.info(
      {
        requestId,
        operation: "knowledge_rag",
        retrievedCount,
        contextCount,
        citationCount,
        durationMs: performance.now() - startedAt,
        outcome,
      },
      "Knowledge grounding completed",
    );
  }

  private async executeMemory(
    request: AgentRunRequest,
    plan: MemoryPlan,
    requestId: string,
    context: TrustedToolContext,
    startedAt: number,
    control: OrchestrationControl,
  ): Promise<CompletedAgentRunResult> {
    const memories = this.dependencies.memories;
    if (memories === undefined)
      throw new AppError({
        code: "INTERNAL_SERVER_ERROR",
        httpStatus: 500,
        message: "Memory service unavailable",
      });
    const requiredPermission =
      plan.type === "memory_read" || plan.type === "memory_search"
        ? "memory.read"
        : "memory.write";
    if (!context.grantedPermissions.includes(requiredPermission))
      throw new AppError({
        code: "PERMISSION_DENIED",
        httpStatus: 403,
        message: "Permission denied",
      });
    control.signal?.throwIfAborted();

    if (plan.type === "memory_read") {
      const rows = await memories.listOwned(
        context.actorId,
        plan.kind === null ? { limit: 10 } : { limit: 10, kind: plan.kind },
      );
      control.signal?.throwIfAborted();
      return this.finalizeMemory(
        request,
        { memoryContext: rows.slice(0, 10).map(sanitizeMemory) },
        requestId,
        startedAt,
        control,
        "memory_read",
      );
    }
    if (plan.type === "memory_search") {
      if (memories.searchOwnedRelevant === undefined)
        throw new AppError({
          code: "MEMORY_EMBEDDING_UNAVAILABLE",
          httpStatus: 503,
          message: "Semantic memory retrieval is unavailable",
        });
      const rows = await memories.searchOwnedRelevant(
        context.actorId,
        plan.query,
        requestId,
      );
      control.signal?.throwIfAborted();
      return this.finalizeMemory(
        request,
        { memoryContext: rows.slice(0, 10).map(sanitizeMemory) },
        requestId,
        startedAt,
        control,
        "memory_search",
      );
    }

    control.onPhaseChange?.("TOOL_EXECUTION");
    control.onToolDispatched?.();
    if (plan.type === "memory_create") {
      const created = await memories.create(
        context.actorId,
        { kind: plan.kind, content: plan.content },
        requestId,
      );
      control.onToolCompleted?.();
      control.signal?.throwIfAborted();
      return this.finalizeMemory(
        request,
        {
          memoryResult: {
            operation: "created",
            memory: sanitizeMemory(created),
          },
        },
        requestId,
        startedAt,
        control,
        "memory_create",
      );
    }

    await memories.deleteOwned(context.actorId, plan.memoryId);
    control.onToolCompleted?.();
    control.signal?.throwIfAborted();
    return this.finalizeMemory(
      request,
      { memoryResult: { operation: "deleted", memoryId: plan.memoryId } },
      requestId,
      startedAt,
      control,
      "memory_delete",
    );
  }

  private async finalizeMemory(
    request: AgentRunRequest,
    continuation: Pick<AgentRequest, "memoryContext" | "memoryResult">,
    requestId: string,
    startedAt: number,
    control: OrchestrationControl,
    planType:
      "memory_read" | "memory_search" | "memory_create" | "memory_delete",
  ): Promise<CompletedAgentRunResult> {
    let final: AgentResult;
    try {
      control.onPhaseChange?.("AGENT_FINALIZATION");
      final = await this.respond(
        { ...request, ...continuation },
        requestId,
        control.signal,
      );
    } catch {
      this.dependencies.logger?.error(
        {
          requestId,
          phase: "agent-finalization",
          memoryOperation: planType,
          memoryMutationSucceeded:
            planType !== "memory_read" && planType !== "memory_search",
          duration: performance.now() - startedAt,
        },
        "Agent finalization failed after memory operation",
      );
      throw new AppError({
        code: "AGENT_FINALIZATION_FAILED",
        httpStatus: 502,
        message:
          planType === "memory_read" || planType === "memory_search"
            ? "Memory was read, but the final agent response could not be generated"
            : "The memory operation may have completed, but the final agent response could not be generated",
      });
    }
    if (final.plan.type !== "respond")
      throw new AppError({
        code: "ORCHESTRATION_STEP_LIMIT_EXCEEDED",
        httpStatus: 500,
        message: "Agent orchestration step limit exceeded",
      });
    this.logCompleted(requestId, planType, 2, startedAt);
    return completed(final.response, 2);
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
      context,
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
    if (final.plan.type !== "respond")
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
    planType:
      | "respond"
      | "tool"
      | "memory_read"
      | "memory_search"
      | "memory_create"
      | "memory_delete"
      | "knowledge_search"
      | "workflow",
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

function sanitizeMemory(memory: MemoryContextView) {
  return Object.freeze({
    id: memory.id,
    kind: memory.kind,
    content: memory.content.slice(0, 4096),
  });
}

function completed(
  text: string,
  steps: 1 | 2,
  citations?: readonly KnowledgeCitation[],
): CompletedAgentRunResult {
  return {
    status: "completed",
    response: {
      text,
      ...(citations === undefined ? {} : { citations }),
    },
    steps,
  };
}

interface TrustedKnowledgeSource {
  readonly context: KnowledgeContextItem;
  readonly citation: KnowledgeCitation;
}

function buildKnowledgeContext(
  rows: readonly KnowledgeSearchResultView[],
): TrustedKnowledgeSource[] {
  const sources: TrustedKnowledgeSource[] = [];
  let remaining = KNOWLEDGE_RAG_CONTEXT_MAX_CHARACTERS;
  for (const row of rows.slice(0, 10)) {
    const title = truncateUnicode(row.title, 200);
    const availableContent = remaining - unicodeLength(title);
    if (availableContent < 1) break;
    const content = truncateUnicode(
      row.content,
      Math.min(2000, availableContent),
    );
    if (content.length === 0) break;
    const reference = `K${sources.length + 1}`;
    sources.push({
      context: Object.freeze({
        reference,
        title,
        content,
        ordinal: row.ordinal,
      }),
      citation: Object.freeze({
        id: reference,
        documentId: row.documentId,
        chunkId: row.chunkId,
        title,
        ordinal: row.ordinal,
      }),
    });
    remaining -= unicodeLength(title) + unicodeLength(content);
    if (remaining < 1) break;
  }
  return sources;
}

function resolveCitations(
  sources: readonly TrustedKnowledgeSource[],
  citationIds: readonly string[],
): KnowledgeCitation[] {
  const requested = new Set(citationIds);
  if (
    citationIds.some(
      (id) => !sources.some((source) => source.citation.id === id),
    )
  )
    throw groundingFailed();
  return sources
    .filter((source) => requested.has(source.citation.id))
    .map((source) => source.citation);
}

function truncateUnicode(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function groundingFailed(): AppError {
  return new AppError({
    code: "KNOWLEDGE_GROUNDING_FAILED",
    httpStatus: 502,
    message: "Knowledge grounding failed",
  });
}
