import { describe, expect, it } from "vitest";

import { AppError } from "../src/errors/app-error.js";
import {
  normalizeWorkflowPlan,
  workflowPlanSchema,
} from "../src/workflows/workflow-plan.js";

const valid = {
  type: "workflow" as const,
  goal: "Prepare for a meeting",
  steps: [
    {
      id: "finish",
      kind: "knowledge_search" as const,
      dependsOn: ["calendar", "preferences"],
      query: "project notes",
    },
    {
      id: "calendar",
      kind: "tool" as const,
      dependsOn: [],
      tool: { name: "calendar.events.list", input: { maxResults: 1 } },
    },
    {
      id: "preferences",
      kind: "memory_read" as const,
      dependsOn: [],
      memoryKind: "preference" as const,
    },
  ],
};

describe("workflow plan", () => {
  it("produces a deterministic topological order without changing dependencies", () => {
    const parsed = workflowPlanSchema.parse(valid);
    const first = normalizeWorkflowPlan(parsed);
    const second = normalizeWorkflowPlan(parsed);
    expect(first).toEqual(second);
    expect(first.steps.map((step) => step.id)).toEqual([
      "calendar",
      "preferences",
      "finish",
    ]);
    expect(first.steps[2]?.dependsOn).toEqual(["calendar", "preferences"]);
  });

  it.each([
    { ...valid, steps: [valid.steps[1], valid.steps[1]] },
    {
      ...valid,
      steps: [valid.steps[1], { ...valid.steps[2], dependsOn: ["missing"] }],
    },
    {
      ...valid,
      steps: [
        { ...valid.steps[1], dependsOn: ["preferences"] },
        { ...valid.steps[2], dependsOn: ["calendar"] },
      ],
    },
    {
      ...valid,
      steps: [
        valid.steps[1],
        { ...valid.steps[2], dependsOn: ["calendar", "calendar"] },
      ],
    },
  ])(
    "rejects duplicate, missing, repeated, and cyclic dependencies",
    (plan) => {
      const parsed = workflowPlanSchema.parse(plan);
      try {
        normalizeWorkflowPlan(parsed);
        throw new Error("Expected workflow validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toMatch(
          /WORKFLOW_(DEPENDENCY_INVALID|CYCLE_DETECTED)/,
        );
      }
    },
  );

  it.each([
    { ...valid, actorId: "attacker" },
    { ...valid, permissions: ["admin"] },
    { ...valid, status: "RUNNING" },
    { ...valid, workflowId: "attacker" },
    {
      ...valid,
      steps: [{ ...valid.steps[1], retry: 3 }],
    },
    {
      ...valid,
      steps: [{ ...valid.steps[1], approvalId: "forged" }],
    },
    {
      ...valid,
      steps: [{ ...valid.steps[1], providerToken: "secret" }],
    },
    {
      ...valid,
      steps: [
        {
          ...valid.steps[1],
          tool: { name: "shell.execute", input: {} },
        },
      ],
    },
  ])("rejects runtime and authority injection", (plan) => {
    expect(workflowPlanSchema.safeParse(plan).success).toBe(false);
  });
});
