import { describe, expect, it, vi } from "vitest";

import type {
  AgentResult,
  AgentServiceClient,
} from "../src/clients/agent/agent-service-client.js";
import type { ToolServiceClient } from "../src/clients/tools/tool-service-client.js";
import { AppError } from "../src/errors/app-error.js";
import { AgentToolOrchestrator } from "../src/orchestration/agent-tool-orchestrator.js";

const requestId = "orchestration-test-1";
const request = { message: "echo AURA" };
const authorizationContext = {
  actorId: "local-user-001",
  grantedPermissions: ["system.echo"],
} as const;
const toolPlan: AgentResult = {
  requestId,
  intent: "propose_tool",
  response: "I can propose the echo tool for that request.",
  plan: {
    type: "tool",
    tool: { name: "system.echo", input: { message: "AURA" } },
  },
};
const finalPlan: AgentResult = {
  requestId,
  intent: "respond",
  response: "Echo completed successfully: AURA",
  plan: { type: "respond" },
};

function dependencies(agentResults: readonly AgentResult[] = [finalPlan]) {
  const respond = vi.fn<AgentServiceClient["respond"]>();
  for (const result of agentResults) respond.mockResolvedValueOnce(result);
  const execute = vi.fn<ToolServiceClient["execute"]>().mockResolvedValue({
    status: "success",
    tool: "system.echo",
    data: { message: "AURA" },
  });
  const orchestrator = new AgentToolOrchestrator({
    agentClient: { respond },
    toolClient: { execute },
  });
  return { orchestrator, respond, execute };
}

describe("AgentToolOrchestrator", () => {
  it("persists and suspends an authoritative REQUIRED proposal without executing", async () => {
    const respond = vi
      .fn<AgentServiceClient["respond"]>()
      .mockResolvedValue(toolPlan);
    const execute = vi.fn<ToolServiceClient["execute"]>();
    const prepare = vi
      .fn<NonNullable<ToolServiceClient["prepare"]>>()
      .mockResolvedValue({
        tool: "test.approval-required",
        version: 1,
        title: "Test action",
        approvalPolicy: "REQUIRED",
        input: { value: "fixed" },
        inputDigest: "a".repeat(64),
        preview: "Run test action",
      });
    const create = vi.fn().mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000099",
      title: "Test action",
      preview: "Run test action",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const orchestrator = new AgentToolOrchestrator({
      agentClient: { respond },
      toolClient: { prepare, execute },
      approvals: { create },
    });

    const result = await orchestrator.run(
      request,
      requestId,
      authorizationContext,
    );

    expect(result).toMatchObject({
      status: "approval_required",
      approval: { title: "Test action", preview: "Run test action" },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: authorizationContext.actorId,
        toolName: "test.approval-required",
        input: { value: "fixed" },
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledOnce();
  });

  it("resumes an approved exact action through Agent continuation", async () => {
    const { orchestrator, respond, execute } = dependencies([finalPlan]);
    await expect(
      orchestrator.resumeApproved(
        request,
        { name: "system.echo", input: { message: "AURA" } },
        authorizationContext,
        requestId,
      ),
    ).resolves.toMatchObject({ status: "completed", steps: 2 });
    expect(execute).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0].toolResult).toMatchObject({
      tool: "system.echo",
    });
    expect(respond.mock.calls[0]?.[1]).toBe(requestId);
  });

  it("returns a direct response without calling Tool Service", async () => {
    const { orchestrator, respond, execute } = dependencies([finalPlan]);
    await expect(
      orchestrator.run({ message: "hello" }, requestId, authorizationContext),
    ).resolves.toEqual({
      status: "completed",
      response: { text: "Echo completed successfully: AURA" },
      steps: 1,
    });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes one proposal and sends its safe result back to Agent", async () => {
    const { orchestrator, respond, execute } = dependencies([
      toolPlan,
      finalPlan,
    ]);
    await expect(
      orchestrator.run(request, requestId, authorizationContext),
    ).resolves.toEqual({
      status: "completed",
      response: { text: "Echo completed successfully: AURA" },
      steps: 2,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      { tool: "system.echo", input: { message: "AURA" } },
      authorizationContext,
      requestId,
    );
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenNthCalledWith(
      2,
      {
        message: "echo AURA",
        toolResult: {
          tool: "system.echo",
          status: "success",
          data: { message: "AURA" },
        },
      },
      requestId,
    );
  });

  it("stops when initial Agent planning fails", async () => {
    const { orchestrator, respond, execute } = dependencies([]);
    respond.mockRejectedValueOnce(
      new AppError({
        code: "UPSTREAM_SERVICE_UNAVAILABLE",
        httpStatus: 502,
        message: "Agent unavailable",
      }),
    );
    await expect(
      orchestrator.run(request, requestId, authorizationContext),
    ).rejects.toMatchObject({
      code: "UPSTREAM_SERVICE_UNAVAILABLE",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("stops on authoritative Tool Service failure without finalizing", async () => {
    const { orchestrator, respond, execute } = dependencies([toolPlan]);
    execute.mockRejectedValueOnce(
      new AppError({
        code: "PERMISSION_DENIED",
        httpStatus: 403,
        message: "Tool permission denied",
      }),
    );
    await expect(
      orchestrator.run(request, requestId, authorizationContext),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(respond).toHaveBeenCalledOnce();
  });

  it("reports partial failure without retrying a successful tool", async () => {
    const { orchestrator, respond, execute } = dependencies([toolPlan]);
    respond.mockRejectedValueOnce(
      new Error("Agent unavailable after execution"),
    );
    await expect(
      orchestrator.run(request, requestId, authorizationContext),
    ).rejects.toMatchObject({
      code: "AGENT_FINALIZATION_FAILED",
      httpStatus: 502,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it("rejects a second tool plan without a second execution", async () => {
    const { orchestrator, respond, execute } = dependencies([
      toolPlan,
      toolPlan,
    ]);
    await expect(
      orchestrator.run(request, requestId, authorizationContext),
    ).rejects.toMatchObject({
      code: "ORCHESTRATION_STEP_LIMIT_EXCEEDED",
    });
    expect(respond).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledOnce();
  });
});
