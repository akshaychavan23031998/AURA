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

  it("accepts a typed scalar reference from a declared ancestor", () => {
    const plan = referencePlan({ fromStep: "calculate", field: "result" });
    expect(normalizeWorkflowPlan(workflowPlanSchema.parse(plan))).toMatchObject(
      {
        steps: [
          { id: "calculate" },
          {
            id: "list",
            tool: {
              input: { maxResults: { fromStep: "calculate", field: "result" } },
            },
          },
        ],
      },
    );
  });

  it.each([
    { fromStep: "calculate", field: "result", nested: true },
    { fromStep: "missing", field: "result" },
    { fromStep: "list", field: "result" },
    { fromStep: "calculate", field: "missing" },
    { fromStep: "calculate", field: "expression" },
  ])(
    "rejects malformed, unavailable, and incompatible references",
    (reference) => {
      expect(() =>
        normalizeWorkflowPlan(
          workflowPlanSchema.parse(referencePlan(reference)),
        ),
      ).toThrow(AppError);
    },
  );

  it("rejects a parallel sibling reference without adding a dependency", () => {
    const plan = referencePlan({ fromStep: "calculate", field: "result" });
    plan.steps[1]!.dependsOn = [];
    try {
      normalizeWorkflowPlan(workflowPlanSchema.parse(plan));
      throw new Error("Expected workflow reference validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("WORKFLOW_REFERENCE_NOT_ANCESTOR");
    }
    expect(plan.steps[1]!.dependsOn).toEqual([]);
  });

  it("accepts a transitive ancestor reference", () => {
    const plan = {
      ...referencePlan({ fromStep: "calculate", field: "result" }),
      steps: [
        referencePlan(null).steps[0]!,
        {
          id: "middle",
          kind: "memory_read" as const,
          dependsOn: ["calculate"],
          memoryKind: null,
        },
        {
          ...referencePlan({ fromStep: "calculate", field: "result" })
            .steps[1]!,
          dependsOn: ["middle"],
        },
      ],
    };
    expect(() =>
      normalizeWorkflowPlan(workflowPlanSchema.parse(plan)),
    ).not.toThrow();
  });

  it("does not interpret template-like strings as references", () => {
    const plan = referencePlan("${calculate.result}");
    expect(() =>
      normalizeWorkflowPlan(workflowPlanSchema.parse(plan)),
    ).not.toThrow();
  });

  it("enforces the per-step reference bound before destination resolution", () => {
    const plan = referencePlan(null);
    const destinationInput = plan.steps[1]!.tool.input as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(destinationInput))
      delete destinationInput[key];
    Object.assign(
      destinationInput,
      Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [
          `field${index}`,
          { fromStep: "calculate", field: "result" },
        ]),
      ),
    );
    try {
      normalizeWorkflowPlan(workflowPlanSchema.parse(plan));
      throw new Error("Expected reference bound validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("WORKFLOW_REFERENCE_INVALID");
    }
  });
});

function referencePlan(reference: unknown) {
  return {
    type: "workflow" as const,
    goal: "Use a safe scalar result",
    steps: [
      {
        id: "calculate",
        kind: "tool" as const,
        dependsOn: [],
        tool: {
          name: "utility.calculator" as const,
          input: { expression: "1+2" },
        },
      },
      {
        id: "list",
        kind: "tool" as const,
        dependsOn: ["calculate"],
        tool: {
          name: "calendar.events.list" as const,
          input: {
            timeMin: "2026-01-01T00:00:00Z",
            timeMax: "2026-01-02T00:00:00Z",
            maxResults: reference,
          },
        },
      },
    ],
  };
}
