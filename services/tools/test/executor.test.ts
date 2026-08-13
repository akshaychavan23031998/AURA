import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type { ExecutionContext } from "../src/domain/tool-context.js";
import { ToolExecutor } from "../src/execution/tool-executor.js";
import type { ToolDefinition } from "../src/registry/tool-definition.js";
import { ToolRegistry } from "../src/registry/tool-registry.js";

const baseContext: ExecutionContext = {
  requestId: "request-1",
  actorId: "actor-1",
  grantedPermissions: ["test.write"],
};

function createWriteTool(
  execute = vi.fn((input: { value: string }) => Promise.resolve(input)),
) {
  const tool: ToolDefinition<{ value: string }, { value: string }> = {
    name: "test.write",
    description: "Controlled test write.",
    inputSchema: z.object({ value: z.string() }).strict(),
    requiredPermissions: ["test.write"],
    riskLevel: "WRITE",
    requiresApproval: true,
    execute,
  };
  return tool;
}

function createExecutor(tool = createWriteTool()) {
  const registry = new ToolRegistry();
  registry.register(tool);
  return { executor: new ToolExecutor(registry), tool };
}

describe("ToolExecutor", () => {
  it("executes validated input when policy permits", async () => {
    const execute = vi.fn((input: { value: string }) => Promise.resolve(input));
    const tool = createWriteTool(execute);
    const { executor } = createExecutor(tool);
    const result = await executor.execute({
      tool: "test.write",
      input: { value: "safe" },
      context: {
        ...baseContext,
        approval: {
          status: "approved",
          approvalId: "approval-1",
          approvedBy: "reviewer-1",
          approvedActorId: "actor-1",
          approvedTool: "test.write",
        },
      },
    });
    expect(result).toEqual({
      status: "success",
      tool: "test.write",
      data: { value: "safe" },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects invalid tool input before execution", async () => {
    const execute = vi.fn((input: { value: string }) => Promise.resolve(input));
    const tool = createWriteTool(execute);
    const { executor } = createExecutor(tool);
    await expect(
      executor.execute({ tool: "test.write", input: {}, context: baseContext }),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects missing permissions before execution", async () => {
    const execute = vi.fn((input: { value: string }) => Promise.resolve(input));
    const tool = createWriteTool(execute);
    const { executor } = createExecutor(tool);
    await expect(
      executor.execute({
        tool: "test.write",
        input: { value: "safe" },
        context: { ...baseContext, grantedPermissions: [] },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires approval for configured write tools", async () => {
    const { executor } = createExecutor();
    await expect(
      executor.execute({
        tool: "test.write",
        input: { value: "safe" },
        context: baseContext,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("always requires approval for destructive tools", async () => {
    const destructive = {
      ...createWriteTool(),
      riskLevel: "DESTRUCTIVE",
      requiresApproval: false,
    } as const;
    const { executor } = createExecutor(destructive);
    await expect(
      executor.execute({
        tool: "test.write",
        input: { value: "safe" },
        context: baseContext,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("rejects approval issued for another actor or tool", async () => {
    const { executor } = createExecutor();
    await expect(
      executor.execute({
        tool: "test.write",
        input: { value: "safe" },
        context: {
          ...baseContext,
          approval: {
            status: "approved",
            approvalId: "approval-1",
            approvedBy: "reviewer-1",
            approvedActorId: "another-actor",
            approvedTool: "test.write",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("maps adapter exceptions to a safe execution error", async () => {
    const tool = createWriteTool(
      vi.fn(() => Promise.reject(new Error("private adapter failure"))),
    );
    const { executor } = createExecutor(tool);
    await expect(
      executor.execute({
        tool: "test.write",
        input: { value: "safe" },
        context: {
          ...baseContext,
          approval: {
            status: "approved",
            approvalId: "approval-1",
            approvedBy: "reviewer-1",
            approvedActorId: "actor-1",
            approvedTool: "test.write",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
  });
});
