import { AppError } from "../errors/app-error.js";
import {
  normalizeWorkflowPlan,
  workflowPlanSchema,
  type WorkflowPlan,
} from "./workflow-plan.js";
import type {
  PersistedWorkflowGraph,
  WorkflowRepository,
} from "./workflow-repository.js";

export const WORKFLOW_LIST_DEFAULT_LIMIT = 20;
export const WORKFLOW_LIST_MAX_LIMIT = 50;

export interface WorkflowStepView {
  readonly stepKey: string;
  readonly kind: "tool" | "memory_read" | "memory_search" | "knowledge_search";
  readonly ordinal: number;
  readonly status:
    | "READY"
    | "BLOCKED"
    | "RUNNING"
    | "AWAITING_APPROVAL"
    | "SUCCEEDED"
    | "FAILED"
    | "SKIPPED"
    | "CANCELLED"
    | "RECOVERY_REQUIRED";
  readonly dependsOn: readonly string[];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly errorCode: string | null;
  readonly hasResult: boolean;
}
export interface WorkflowView {
  readonly id: string;
  readonly goal: string;
  readonly status:
    | "READY"
    | "RUNNING"
    | "AWAITING_APPROVAL"
    | "PAUSED"
    | "COMPLETED"
    | "FAILED"
    | "CANCELLED"
    | "RECOVERY_REQUIRED";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancelledAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly steps: readonly WorkflowStepView[];
}
export type WorkflowSummaryView = Omit<WorkflowView, "steps">;

export interface WorkflowStore {
  create(actorId: string, plan: WorkflowPlan): Promise<WorkflowView>;
  getOwned(actorId: string, workflowId: string): Promise<WorkflowView>;
  listOwned(actorId: string, limit: number): Promise<WorkflowSummaryView[]>;
  cancelOwned(actorId: string, workflowId: string): Promise<WorkflowView>;
}

export class WorkflowService implements WorkflowStore {
  public constructor(private readonly repository: WorkflowRepository) {}

  public async create(
    actorId: string,
    plan: WorkflowPlan,
  ): Promise<WorkflowView> {
    const parsed = workflowPlanSchema.safeParse(plan);
    if (!parsed.success)
      throw new AppError({
        code: "WORKFLOW_INPUT_INVALID",
        httpStatus: 400,
        message: "Workflow input is invalid",
      });
    const normalized = normalizeWorkflowPlan(parsed.data);
    try {
      return graphView(
        await this.repository.createTransactional(actorId, normalized),
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw storageFailed(error);
    }
  }

  public async getOwned(
    actorId: string,
    workflowId: string,
  ): Promise<WorkflowView> {
    try {
      const graph = await this.repository.getOwned(actorId, workflowId);
      if (graph === undefined) throw notFound();
      return graphView(graph);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw storageFailed(error);
    }
  }

  public async listOwned(
    actorId: string,
    limit: number,
  ): Promise<WorkflowSummaryView[]> {
    try {
      return (await this.repository.listOwned(actorId, limit)).map(summaryView);
    } catch (error) {
      throw storageFailed(error);
    }
  }

  public async cancelOwned(
    actorId: string,
    workflowId: string,
  ): Promise<WorkflowView> {
    try {
      const row = await this.repository.cancelOwned(
        actorId,
        workflowId,
        new Date(),
      );
      if (row === undefined) throw notFound();
      if (row.status !== "CANCELLED") throw stateInvalid();
      const graph = await this.repository.getOwned(actorId, workflowId);
      if (graph === undefined) throw notFound();
      return graphView(graph);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw storageFailed(error);
    }
  }
}

function graphView(graph: PersistedWorkflowGraph): WorkflowView {
  const keyById = new Map(graph.steps.map((step) => [step.id, step.stepKey]));
  const dependencies = new Map<string, string[]>();
  const executionByStep = new Map(
    graph.executions.map((execution) => [execution.stepId, execution]),
  );
  for (const dependency of graph.dependencies) {
    const stepKey = keyById.get(dependency.stepId);
    const dependsOnKey = keyById.get(dependency.dependsOnStepId);
    if (stepKey === undefined || dependsOnKey === undefined)
      throw storageFailed();
    const current = dependencies.get(stepKey) ?? [];
    current.push(dependsOnKey);
    dependencies.set(stepKey, current);
  }
  return Object.freeze({
    ...summaryView(graph.workflow),
    steps: graph.steps
      .slice()
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((step) => {
        const execution = executionByStep.get(step.id);
        return Object.freeze({
          stepKey: step.stepKey,
          kind: step.kind,
          ordinal: step.ordinal,
          status: step.status,
          dependsOn: Object.freeze(dependencies.get(step.stepKey) ?? []),
          payload: Object.freeze(step.payload as Record<string, unknown>),
          startedAt: step.startedAt?.toISOString() ?? null,
          completedAt: step.completedAt?.toISOString() ?? null,
          errorCode: execution?.errorCode ?? null,
          hasResult: execution?.result != null,
        });
      }),
  });
}

function summaryView(
  row: PersistedWorkflowGraph["workflow"],
): WorkflowSummaryView {
  return Object.freeze({
    id: row.id,
    goal: row.goal,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  });
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
function storageFailed(cause?: unknown) {
  return new AppError({
    code: "WORKFLOW_STORAGE_FAILED",
    httpStatus: 500,
    message: "Workflow storage operation failed",
    cause,
  });
}
