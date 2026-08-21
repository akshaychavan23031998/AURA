import { z } from "zod";

import { AppError } from "../errors/app-error.js";
import type { PersistedWorkflowGraph } from "./workflow-repository.js";
import type { WorkflowPlan, WorkflowStep } from "./workflow-plan.js";

export const WORKFLOW_MAX_REFERENCES_PER_STEP = 8;

export const workflowReferenceSchema = z
  .object({
    fromStep: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    field: z.string().min(1).max(64),
  })
  .strict();

export type WorkflowReference = z.infer<typeof workflowReferenceSchema>;
type ScalarType = "string" | "number" | "boolean";

interface ExportDefinition {
  readonly type: ScalarType;
  readonly read: (result: unknown) => unknown;
}

const exportsByTool: Readonly<
  Record<string, Readonly<Record<string, ExportDefinition>>>
> = {
  "utility.calculator": {
    expression: { type: "string", read: direct("expression") },
    result: { type: "number", read: direct("result") },
  },
  "calendar.events.create": {
    eventId: { type: "string", read: nested("event", "eventId") },
  },
  "calendar.events.get": {
    eventId: { type: "string", read: nested("event", "eventId") },
  },
  "calendar.events.update": {
    eventId: { type: "string", read: nested("event", "eventId") },
  },
  "gmail.messages.send": {
    messageId: { type: "string", read: direct("messageId") },
    threadId: { type: "string", read: direct("threadId") },
  },
  "gmail.messages.reply": {
    messageId: { type: "string", read: direct("messageId") },
    threadId: { type: "string", read: direct("threadId") },
  },
  "contacts.people.get": {
    resourceName: { type: "string", read: nested("contact", "resourceName") },
  },
};

const destinationsByTool: Readonly<
  Record<string, Readonly<Record<string, ScalarType>>>
> = {
  "calendar.events.list": { maxResults: "number" },
  "calendar.events.get": { eventId: "string" },
  "calendar.events.update": { eventId: "string" },
  "calendar.events.delete": { eventId: "string" },
  "gmail.messages.reply": { messageId: "string" },
  "gmail.messages.list": { maxResults: "number" },
  "contacts.people.list": { maxResults: "number" },
  "contacts.people.get": { resourceName: "string" },
};

export function validateWorkflowReferences(plan: WorkflowPlan): void {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  for (const step of plan.steps) {
    if (step.kind !== "tool") continue;
    const references = collectReferences(step);
    if (references.length > WORKFLOW_MAX_REFERENCES_PER_STEP)
      throw referenceError("WORKFLOW_REFERENCE_INVALID");
    const destinations = destinationsByTool[step.tool.name] ?? {};
    for (const { destination, reference } of references) {
      const source = byId.get(reference.fromStep);
      if (source === undefined || source.id === step.id)
        throw referenceError("WORKFLOW_REFERENCE_INVALID");
      if (!isAncestor(plan.steps, source.id, step.id))
        throw referenceError("WORKFLOW_REFERENCE_NOT_ANCESTOR");
      if (source.kind !== "tool")
        throw referenceError("WORKFLOW_REFERENCE_FIELD_INVALID");
      const exported = exportsByTool[source.tool.name]?.[reference.field];
      if (exported === undefined)
        throw referenceError("WORKFLOW_REFERENCE_FIELD_INVALID");
      const destinationType = destinations[destination];
      if (destinationType === undefined)
        throw referenceError("WORKFLOW_REFERENCE_FIELD_INVALID");
      if (destinationType !== exported.type)
        throw referenceError("WORKFLOW_REFERENCE_TYPE_MISMATCH");
    }
  }
}

export function resolveWorkflowToolInput(
  graph: PersistedWorkflowGraph,
  destinationStepId: string,
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const destination = graph.steps.find((step) => step.id === destinationStepId);
  if (destination === undefined || destination.workflowId !== graph.workflow.id)
    throw resolutionFailed();
  const destinations = destinationsByTool[toolName] ?? {};
  const resolved: Record<string, unknown> = { ...input };
  for (const [field, value] of Object.entries(input)) {
    const parsed = workflowReferenceSchema.safeParse(value);
    if (!parsed.success) {
      if (isReferenceLike(value)) throw resolutionFailed();
      continue;
    }
    if (destinations[field] === undefined) throw resolutionFailed();
    const source = graph.steps.find(
      (step) => step.stepKey === parsed.data.fromStep,
    );
    if (
      source === undefined ||
      source.workflowId !== graph.workflow.id ||
      source.status !== "SUCCEEDED" ||
      !persistedAncestor(graph, source.id, destination.id)
    )
      throw resolutionFailed();
    const execution = graph.executions.find(
      (item) =>
        item.stepId === source.id &&
        item.attemptNumber === 1 &&
        item.status === "SUCCEEDED",
    );
    if (execution?.result === null || execution?.result === undefined)
      throw resolutionFailed();
    const payload = source.payload as Record<string, unknown>;
    const sourceTool = (payload.tool as { name?: unknown } | undefined)?.name;
    if (typeof sourceTool !== "string") throw resolutionFailed();
    const exported = exportsByTool[sourceTool]?.[parsed.data.field];
    if (exported === undefined || exported.type !== destinations[field])
      throw resolutionFailed();
    const scalar = exported.read(execution.result);
    if (typeof scalar !== exported.type) throw resolutionFailed();
    resolved[field] = scalar;
  }
  return resolved;
}

function collectReferences(step: Extract<WorkflowStep, { kind: "tool" }>) {
  return Object.entries(step.tool.input).flatMap(([destination, value]) => {
    const parsed = workflowReferenceSchema.safeParse(value);
    if (parsed.success) return [{ destination, reference: parsed.data }];
    if (isReferenceLike(value))
      throw referenceError("WORKFLOW_REFERENCE_INVALID");
    return [];
  });
}

function isReferenceLike(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ("fromStep" in value || "field" in value)
  );
}

function isAncestor(
  steps: readonly WorkflowStep[],
  sourceId: string,
  destinationId: string,
): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const pending = [...(byId.get(destinationId)?.dependsOn ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || visited.has(current)) continue;
    if (current === sourceId) return true;
    visited.add(current);
    pending.push(...(byId.get(current)?.dependsOn ?? []));
  }
  return false;
}

function persistedAncestor(
  graph: PersistedWorkflowGraph,
  sourceId: string,
  destinationId: string,
): boolean {
  const pending = graph.dependencies
    .filter((item) => item.stepId === destinationId)
    .map((item) => item.dependsOnStepId);
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || visited.has(current)) continue;
    if (current === sourceId) return true;
    visited.add(current);
    pending.push(
      ...graph.dependencies
        .filter((item) => item.stepId === current)
        .map((item) => item.dependsOnStepId),
    );
  }
  return false;
}

function direct(key: string): (result: unknown) => unknown {
  return (result) => object(result)?.[key];
}
function nested(parent: string, key: string): (result: unknown) => unknown {
  return (result) => object(object(result)?.[parent])?.[key];
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function referenceError(code: string): AppError {
  return new AppError({
    code,
    httpStatus: 502,
    message: "Workflow reference is invalid",
  });
}
function resolutionFailed(): AppError {
  return new AppError({
    code: "WORKFLOW_REFERENCE_RESOLUTION_FAILED",
    httpStatus: 500,
    message: "Workflow reference could not be resolved",
  });
}
