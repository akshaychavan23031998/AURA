import { describe, expect, it, vi } from "vitest";

import type {
  AgentResult,
  AgentServiceClient,
} from "../src/clients/agent/agent-service-client.js";
import type { ToolServiceClient } from "../src/clients/tools/tool-service-client.js";
import { AppError } from "../src/errors/app-error.js";
import { AgentToolOrchestrator } from "../src/orchestration/agent-tool-orchestrator.js";
import type { MemoryStore } from "../src/memory/memory-service.js";

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
const memoryId = "00000000-0000-4000-8000-000000000010";
const memory = {
  id: memoryId,
  kind: "preference" as const,
  content: "Prefers dark mode",
  source: "user_explicit" as const,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

function memoryStore(): MemoryStore {
  return {
    create: vi.fn().mockResolvedValue(memory),
    getOwned: vi.fn().mockResolvedValue(memory),
    listOwned: vi.fn().mockResolvedValue([memory]),
    searchOwnedRelevant: vi.fn().mockResolvedValue([memory]),
    deleteOwned: vi.fn().mockResolvedValue(undefined),
  };
}

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

  it("creates one explicit owner-scoped memory and continues once", async () => {
    const memories = memoryStore();
    const respond = vi
      .fn<AgentServiceClient["respond"]>()
      .mockResolvedValueOnce({
        requestId,
        intent: "propose_memory_create",
        response: "I can remember that.",
        plan: {
          type: "memory_create",
          kind: "preference",
          content: "Prefers dark mode",
        },
      })
      .mockResolvedValueOnce(finalPlan);
    const orchestrator = new AgentToolOrchestrator({
      agentClient: { respond },
      toolClient: { execute: vi.fn() },
      memories,
    });
    await expect(
      orchestrator.run(
        { message: "Remember that I prefer dark mode" },
        requestId,
        {
          actorId: "actor-1",
          grantedPermissions: ["memory.write"],
        },
      ),
    ).resolves.toMatchObject({ status: "completed", steps: 2 });
    expect(memories.create).toHaveBeenCalledOnce();
    expect(memories.create).toHaveBeenCalledWith(
      "actor-1",
      { kind: "preference", content: "Prefers dark mode" },
      requestId,
    );
    expect(respond).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        memoryResult: {
          operation: "created",
          memory: {
            id: memoryId,
            kind: "preference",
            content: "Prefers dark mode",
          },
        },
      }),
      requestId,
    );
  });

  it("bounds and sanitizes owner-scoped memory context", async () => {
    const memories = memoryStore();
    vi.mocked(memories.listOwned).mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        ...memory,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
    );
    const respond = vi
      .fn<AgentServiceClient["respond"]>()
      .mockResolvedValueOnce({
        requestId,
        intent: "propose_memory_read",
        response: "I can read your saved preferences.",
        plan: { type: "memory_read", kind: "preference" },
      })
      .mockResolvedValueOnce(finalPlan);
    const orchestrator = new AgentToolOrchestrator({
      agentClient: { respond },
      toolClient: { execute: vi.fn() },
      memories,
    });
    await orchestrator.run({ message: "Use my saved preferences" }, requestId, {
      actorId: "actor-1",
      grantedPermissions: ["memory.read"],
    });
    expect(memories.listOwned).toHaveBeenCalledWith("actor-1", {
      limit: 10,
      kind: "preference",
    });
    const context = respond.mock.calls[1]?.[0].memoryContext;
    expect(context).toHaveLength(10);
    expect(context?.[0]).toEqual({
      id: "00000000-0000-4000-8000-000000000000",
      kind: "preference",
      content: "Prefers dark mode",
    });
    expect(JSON.stringify(context)).not.toMatch(
      /source|createdAt|actorId|status/,
    );
  });

  it("runs owner-scoped semantic search with memory.read and hides retrieval metadata", async () => {
    const memories = memoryStore();
    const respond = vi
      .fn<AgentServiceClient["respond"]>()
      .mockResolvedValueOnce({
        requestId,
        intent: "propose_memory_search",
        response: "I can search explicit saved memories.",
        plan: { type: "memory_search", query: "coding language" },
      })
      .mockResolvedValueOnce(finalPlan);
    const orchestrator = new AgentToolOrchestrator({
      agentClient: { respond },
      toolClient: { execute: vi.fn() },
      memories,
    });
    await orchestrator.run(
      { message: "What coding language do I prefer?" },
      requestId,
      { actorId: "actor-1", grantedPermissions: ["memory.read"] },
    );
    expect(memories.searchOwnedRelevant).toHaveBeenCalledWith(
      "actor-1",
      "coding language",
      requestId,
    );
    expect(respond.mock.calls[1]?.[0].memoryContext).toEqual([
      { id: memoryId, kind: "preference", content: "Prefers dark mode" },
    ]);
  });

  it("does not allow memory.write to authorize semantic search", async () => {
    const memories = memoryStore();
    const orchestrator = new AgentToolOrchestrator({
      agentClient: {
        respond: vi.fn().mockResolvedValue({
          requestId,
          intent: "propose_memory_search",
          response: "search",
          plan: { type: "memory_search", query: "timezone" },
        }),
      },
      toolClient: { execute: vi.fn() },
      memories,
    });
    await expect(
      orchestrator.run({ message: "saved timezone" }, requestId, {
        actorId: "actor-1",
        grantedPermissions: ["memory.write"],
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(memories.searchOwnedRelevant).not.toHaveBeenCalled();
  });

  it("requires independent memory permissions and never invokes persistence on denial", async () => {
    const memories = memoryStore();
    const createPlan: AgentResult = {
      requestId,
      intent: "propose_memory_create",
      response: "remember",
      plan: { type: "memory_create", kind: "note", content: "safe" },
    };
    const orchestrator = new AgentToolOrchestrator({
      agentClient: {
        respond: vi.fn().mockResolvedValue(createPlan),
      },
      toolClient: { execute: vi.fn() },
      memories,
    });
    await expect(
      orchestrator.run({ message: "Remember safe" }, requestId, {
        actorId: "actor-1",
        grantedPermissions: ["memory.read"],
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED", httpStatus: 403 });
    expect(memories.create).not.toHaveBeenCalled();
  });

  it("deletes exactly one explicit owned memory and rejects a recursive action", async () => {
    const memories = memoryStore();
    const deletePlan: AgentResult = {
      requestId,
      intent: "propose_memory_delete",
      response: "forget",
      plan: { type: "memory_delete", memoryId },
    };
    const respond = vi
      .fn<AgentServiceClient["respond"]>()
      .mockResolvedValueOnce(deletePlan)
      .mockResolvedValueOnce(deletePlan);
    const orchestrator = new AgentToolOrchestrator({
      agentClient: { respond },
      toolClient: { execute: vi.fn() },
      memories,
    });
    await expect(
      orchestrator.run({ message: `Forget memory ${memoryId}` }, requestId, {
        actorId: "actor-1",
        grantedPermissions: ["memory.write"],
      }),
    ).rejects.toMatchObject({ code: "ORCHESTRATION_STEP_LIMIT_EXCEEDED" });
    expect(memories.deleteOwned).toHaveBeenCalledOnce();
    expect(memories.deleteOwned).toHaveBeenCalledWith("actor-1", memoryId);
  });
});
