import { describe, expect, it } from "vitest";

import { AppError } from "../src/errors/app-error.js";
import type { PersistedWorkflowGraph } from "../src/workflows/workflow-repository.js";
import { resolveWorkflowToolInput } from "../src/workflows/workflow-references.js";

describe("workflow reference resolution", () => {
  it("resolves one allowlisted primitive without changing the template or result", () => {
    const graph = fixture();
    const input = { maxResults: { fromStep: "calculate", field: "result" } };
    const before = structuredClone(graph.executions[0]!.result);
    expect(
      resolveWorkflowToolInput(
        graph,
        "destination-id",
        "calendar.events.list",
        input,
      ),
    ).toEqual({ maxResults: 3 });
    expect(input.maxResults).toEqual({
      fromStep: "calculate",
      field: "result",
    });
    expect(graph.executions[0]!.result).toEqual(before);
  });

  it.each([
    ["missing result", { result: null }],
    ["wrong runtime type", { result: { expression: "1+2", result: "3" } }],
    ["source not succeeded", { sourceStatus: "RUNNING" }],
    ["execution not succeeded", { executionStatus: "RUNNING" }],
    ["not an ancestor", { dependencies: [] }],
  ])("fails closed for %s", (_name, change) => {
    const graph = fixture(change);
    expect(() =>
      resolveWorkflowToolInput(
        graph,
        "destination-id",
        "calendar.events.list",
        {
          maxResults: { fromStep: "calculate", field: "result" },
        },
      ),
    ).toThrowError(AppError);
  });

  it.each([
    "accessToken",
    "vector",
    "approvalId",
    "actorId",
    "anything.nested",
  ])("cannot access unallowlisted export %s", (field) => {
    const graph = fixture({
      result: { result: 3, accessToken: "secret", vector: [1], actorId: "x" },
    });
    expect(() =>
      resolveWorkflowToolInput(
        graph,
        "destination-id",
        "calendar.events.list",
        {
          maxResults: { fromStep: "calculate", field },
        },
      ),
    ).toThrowError(AppError);
  });
});

function fixture(
  change: {
    result?: unknown;
    sourceStatus?: string;
    executionStatus?: string;
    dependencies?: unknown[];
  } = {},
): PersistedWorkflowGraph {
  return {
    workflow: { id: "workflow-id" },
    steps: [
      {
        id: "source-id",
        workflowId: "workflow-id",
        stepKey: "calculate",
        status: change.sourceStatus ?? "SUCCEEDED",
        payload: { tool: { name: "utility.calculator", input: {} } },
      },
      {
        id: "destination-id",
        workflowId: "workflow-id",
        stepKey: "list",
        status: "RUNNING",
        payload: { tool: { name: "calendar.events.list", input: {} } },
      },
    ],
    dependencies: change.dependencies ?? [
      {
        workflowId: "workflow-id",
        stepId: "destination-id",
        dependsOnStepId: "source-id",
      },
    ],
    executions: [
      {
        id: "execution-id",
        workflowId: "workflow-id",
        stepId: "source-id",
        attemptNumber: 1,
        status: change.executionStatus ?? "SUCCEEDED",
        result:
          "result" in change ? change.result : { expression: "1+2", result: 3 },
      },
    ],
  } as unknown as PersistedWorkflowGraph;
}
