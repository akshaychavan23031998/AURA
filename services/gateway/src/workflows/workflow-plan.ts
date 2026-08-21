import { z } from "zod";

import { AppError } from "../errors/app-error.js";
import { validateWorkflowReferences } from "./workflow-references.js";

export const WORKFLOW_MAX_STEPS = 8;
export const WORKFLOW_MAX_GOAL_CHARACTERS = 1024;
export const WORKFLOW_MAX_STEP_ID_CHARACTERS = 64;
export const WORKFLOW_MAX_DEPENDENCIES_PER_STEP = 7;
export const WORKFLOW_ALLOWED_TOOL_NAMES = [
  "system.echo",
  "utility.calculator",
  "utility.datetime",
  "calendar.events.list",
  "calendar.events.get",
  "calendar.events.create",
  "calendar.events.update",
  "calendar.events.delete",
  "gmail.messages.list",
  "gmail.messages.get",
  "gmail.messages.send",
  "gmail.messages.reply",
  "contacts.people.list",
  "contacts.people.get",
] as const;

// Gateway-owned runtime states. These values are deliberately absent from the
// Agent proposal schema; Phase 41 persists the same bounded state vocabulary.
export type WorkflowStatus =
  | "READY"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";
export type WorkflowStepStatus =
  | "BLOCKED"
  | "READY"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "SUCCEEDED"
  | "FAILED"
  | "SKIPPED"
  | "CANCELLED";

const stepIdSchema = z
  .string()
  .max(WORKFLOW_MAX_STEP_ID_CHARACTERS)
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const dependenciesSchema = z
  .array(stepIdSchema)
  .max(WORKFLOW_MAX_DEPENDENCIES_PER_STEP);
const commonStep = {
  id: stepIdSchema,
  dependsOn: dependenciesSchema,
} as const;
const querySchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((value) => !hasUnsafeControl(value));

export const workflowPlanSchema = z
  .object({
    type: z.literal("workflow"),
    goal: z
      .string()
      .trim()
      .min(1)
      .max(WORKFLOW_MAX_GOAL_CHARACTERS)
      .refine((value) => !hasUnsafeControl(value)),
    steps: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              ...commonStep,
              kind: z.literal("tool"),
              tool: z
                .object({
                  name: z.enum(WORKFLOW_ALLOWED_TOOL_NAMES),
                  input: z.record(z.string(), z.json()),
                })
                .strict(),
            })
            .strict(),
          z
            .object({
              ...commonStep,
              kind: z.literal("memory_read"),
              memoryKind: z
                .enum(["preference", "fact", "instruction", "note"])
                .nullable(),
            })
            .strict(),
          z
            .object({
              ...commonStep,
              kind: z.literal("memory_search"),
              query: querySchema,
            })
            .strict(),
          z
            .object({
              ...commonStep,
              kind: z.literal("knowledge_search"),
              query: querySchema,
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(WORKFLOW_MAX_STEPS),
  })
  .strict();

export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;
export type WorkflowStep = WorkflowPlan["steps"][number];

export function normalizeWorkflowPlan(plan: WorkflowPlan): WorkflowPlan {
  const byId = new Map<string, WorkflowStep>();
  for (const step of plan.steps) {
    if (byId.has(step.id)) throw dependencyInvalid();
    byId.set(step.id, step);
    if (new Set(step.dependsOn).size !== step.dependsOn.length)
      throw dependencyInvalid();
  }
  for (const step of plan.steps)
    for (const dependency of step.dependsOn)
      if (dependency === step.id || !byId.has(dependency))
        throw dependencyInvalid();

  const remaining = new Map(
    plan.steps.map((step) => [step.id, new Set(step.dependsOn)]),
  );
  const ordered: WorkflowStep[] = [];
  while (ordered.length < plan.steps.length) {
    const next = plan.steps.find(
      (step) => remaining.has(step.id) && remaining.get(step.id)?.size === 0,
    );
    if (next === undefined) throw cycleDetected();
    ordered.push(next);
    remaining.delete(next.id);
    for (const dependencies of remaining.values()) dependencies.delete(next.id);
  }
  const normalized: WorkflowPlan = {
    type: "workflow",
    goal: plan.goal,
    steps: ordered.map((step) => ({
      ...step,
      dependsOn: [...step.dependsOn],
    })),
  };
  validateWorkflowReferences(normalized);
  return normalized;
}

function dependencyInvalid(): AppError {
  return new AppError({
    code: "WORKFLOW_DEPENDENCY_INVALID",
    httpStatus: 502,
    message: "Workflow dependency graph is invalid",
  });
}

function cycleDetected(): AppError {
  return new AppError({
    code: "WORKFLOW_CYCLE_DETECTED",
    httpStatus: 502,
    message: "Workflow dependency graph contains a cycle",
  });
}

function hasUnsafeControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      (code >= 127 && code <= 159)
    );
  });
}
