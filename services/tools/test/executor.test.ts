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
    version: 1,
    title: "Test write",
    description: "Controlled test write.",
    category: "system",
    inputSchema: z.object({ value: z.string() }).strict(),
    outputSchema: z.object({ value: z.string() }).strict(),
    requiredPermissions: ["test.write"],
    riskLevel: "WRITE",
    approvalPolicy: "REQUIRED",
    idempotency: "NON_IDEMPOTENT",
    timeoutMs: 100,
    enabled: true,
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
      version: 1,
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
    ).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });
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
    ).rejects.toMatchObject({ code: "TOOL_APPROVAL_REQUIRED" });
  });

  it("always requires approval for destructive tools", async () => {
    const destructive = {
      ...createWriteTool(),
      riskLevel: "DESTRUCTIVE",
      approvalPolicy: "NONE",
    } as const;
    const { executor } = createExecutor(destructive);
    await expect(
      executor.execute({
        tool: "test.write",
        input: { value: "safe" },
        context: baseContext,
      }),
    ).rejects.toMatchObject({ code: "TOOL_APPROVAL_REQUIRED" });
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
    ).rejects.toMatchObject({ code: "TOOL_APPROVAL_REQUIRED" });
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

  it("fails closed when an implementation returns invalid output", async () => {
    const tool = createWriteTool(
      vi.fn(() => Promise.resolve({ value: 42 } as never)),
    );
    const { executor } = createExecutor(tool);
    await expect(
      executor.execute({
        tool: "test.write",
        input: { value: "safe" },
        context: { ...baseContext, approval: approved() },
      }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_INVALID" });
  });

  it("rejects disabled and unsupported tool versions", async () => {
    const { executor } = createExecutor({
      ...createWriteTool(),
      enabled: false,
    });
    await expect(
      executor.execute({
        tool: "test.write",
        version: 1,
        input: { value: "safe" },
        context: baseContext,
      }),
    ).rejects.toMatchObject({ code: "TOOL_DISABLED" });
    const active = createExecutor();
    await expect(
      active.executor.execute({
        tool: "test.write",
        version: 2,
        input: { value: "safe" },
        context: baseContext,
      }),
    ).rejects.toMatchObject({ code: "TOOL_VERSION_UNSUPPORTED" });
  });

  it("times out once without retrying", async () => {
    const execute = vi.fn(
      () => new Promise<{ value: string }>(() => undefined),
    );
    const { executor } = createExecutor({
      ...createWriteTool(execute),
      timeoutMs: 5,
    });
    await expect(
      executor.execute({
        tool: "test.write",
        input: { value: "safe" },
        context: { ...baseContext, approval: approved() },
      }),
    ).rejects.toMatchObject({ code: "TOOL_TIMEOUT" });
    expect(execute).toHaveBeenCalledOnce();
  });
});

function approved() {
  return {
    status: "approved" as const,
    approvalId: "approval-1",
    approvedBy: "reviewer-1",
    approvedActorId: "actor-1",
    approvedTool: "test.write",
  };
}
