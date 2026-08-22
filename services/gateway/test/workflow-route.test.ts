import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app/create-app.js";
import type { AllowedPermission } from "../src/auth/principal.js";
import type { AccessTokenVerifier } from "../src/auth/token-verifier.js";
import type { WorkflowRunner } from "../src/workflows/workflow-executor.js";
import type {
  WorkflowStore,
  WorkflowView,
} from "../src/workflows/workflow-service.js";
import { testConfig } from "./test-config.js";

const authorization = { authorization: "Bearer test.header.signature" };

const actorId = "00000000-0000-4000-8000-000000000001";

const workflowId = "00000000-0000-4000-8000-000000000100";

const snapshot: WorkflowView = {
  id: workflowId,
  goal: "Prepare for meeting",
  status: "READY",
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
  cancelledAt: null,
  startedAt: null,
  completedAt: null,
  steps: [
    {
      stepKey: "meeting",
      kind: "tool",
      ordinal: 0,
      status: "READY",
      dependsOn: [],
      payload: {
        tool: {
          name: "calendar.events.list",
          input: {},
        },
      },
      startedAt: null,
      completedAt: null,
      errorCode: null,
      hasResult: false,
    },
  ],
};

function verifier(
  permissions: readonly AllowedPermission[],
): AccessTokenVerifier {
  return {
    verify: () =>
      Promise.resolve({
        actorId,
        sessionId: "00000000-0000-4000-8000-000000000002",
        permissions,
        tokenIssuedAt: 1,
        tokenExpiresAt: 2,
      }),
  };
}

function store(): WorkflowStore {
  return {
    create: vi.fn().mockResolvedValue(snapshot),

    getOwned: vi.fn().mockResolvedValue(snapshot),

    listOwned: vi.fn().mockResolvedValue([
      {
        id: snapshot.id,
        goal: snapshot.goal,
        status: snapshot.status,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        cancelledAt: snapshot.cancelledAt,
        startedAt: snapshot.startedAt,
        completedAt: snapshot.completedAt,
      },
    ]),

    cancelOwned: vi.fn().mockResolvedValue({
      ...snapshot,
      status: "CANCELLED",
      cancelledAt: "2026-08-21T01:00:00.000Z",
    }),

    resolveAmbiguousOwned: vi.fn().mockResolvedValue({
      ...snapshot,
      status: "FAILED",
      completedAt: "2026-08-21T02:00:00.000Z",
      steps: [
        {
          ...snapshot.steps[0],
          status: "FAILED",
          errorCode: "WORKFLOW_AMBIGUITY_NOT_EXECUTED",
          completedAt: "2026-08-21T02:00:00.000Z",
        },
      ],
    }),
  };
}

function runner(): WorkflowRunner {
  return {
    run: vi.fn().mockResolvedValue(snapshot),

    resumeApproved: vi.fn().mockResolvedValue(snapshot),

    rejectApproval: vi.fn().mockResolvedValue(undefined),

    canResumeApproval: vi.fn().mockResolvedValue(true),

    recover: vi.fn().mockResolvedValue(snapshot),
  };
}

describe("workflow routes", () => {
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];

  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  async function app(
    permissions: readonly AllowedPermission[],
    workflows = store(),
    workflowRunner = runner(),
  ) {
    const instance = await createApp({
      config: testConfig,
      logger: false,
      tokenVerifier: verifier(permissions),
      workflowService: workflows,
      workflowRunner,
    });

    apps.push(instance);

    return {
      instance,
      workflows,
      workflowRunner,
    };
  }

  it("requires authentication for all workflow operations", async () => {
    const { instance } = await app(["workflow.read", "workflow.write"]);

    for (const request of [
      {
        method: "GET" as const,
        url: "/api/v1/workflows",
      },
      {
        method: "GET" as const,
        url: `/api/v1/workflows/${workflowId}`,
      },
      {
        method: "POST" as const,
        url: `/api/v1/workflows/${workflowId}/run`,
      },
      {
        method: "POST" as const,
        url: `/api/v1/workflows/${workflowId}/cancel`,
      },
      {
        method: "POST" as const,
        url: `/api/v1/workflows/${workflowId}/recover`,
      },
      {
        method: "POST" as const,
        url: `/api/v1/workflows/${workflowId}/resolve-ambiguity`,
        payload: {
          resolution: "CONFIRMED_NOT_EXECUTED",
        },
      },
    ]) {
      expect((await instance.inject(request)).statusCode).toBe(401);
    }
  });

  it("keeps workflow.read and workflow.write independent", async () => {
    const reader = await app(["workflow.read"]);

    expect(
      (
        await reader.instance.inject({
          method: "GET",
          url: "/api/v1/workflows",
          headers: authorization,
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await reader.instance.inject({
          method: "POST",
          url: `/api/v1/workflows/${workflowId}/cancel`,
          headers: authorization,
        })
      ).statusCode,
    ).toBe(403);

    expect(
      (
        await reader.instance.inject({
          method: "POST",
          url: `/api/v1/workflows/${workflowId}/resolve-ambiguity`,
          headers: authorization,
          payload: {
            resolution: "CONFIRMED_NOT_EXECUTED",
          },
        })
      ).statusCode,
    ).toBe(403);

    const writer = await app(["workflow.write"]);

    expect(
      (
        await writer.instance.inject({
          method: "GET",
          url: "/api/v1/workflows",
          headers: authorization,
        })
      ).statusCode,
    ).toBe(403);

    expect(
      (
        await writer.instance.inject({
          method: "POST",
          url: `/api/v1/workflows/${workflowId}/cancel`,
          headers: authorization,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("requires workflow.write to run and derives the actor server-side", async () => {
    const reader = await app(["workflow.read"]);

    expect(
      (
        await reader.instance.inject({
          method: "POST",
          url: `/api/v1/workflows/${workflowId}/run`,
          headers: authorization,
        })
      ).statusCode,
    ).toBe(403);

    const writer = await app(["workflow.write"]);

    const run = vi.spyOn(writer.workflowRunner, "run");

    expect(
      (
        await writer.instance.inject({
          method: "POST",
          url: `/api/v1/workflows/${workflowId}/run`,
          headers: authorization,
        })
      ).statusCode,
    ).toBe(200);

    expect(run).toHaveBeenCalledWith(
      actorId,
      workflowId,
      expect.objectContaining({
        actorId,
      }),
      expect.any(String),
    );
  });

  it("requires workflow.write for strict explicit recovery", async () => {
    const reader = await app(["workflow.read"]);

    expect(
      (
        await reader.instance.inject({
          method: "POST",
          url: `/api/v1/workflows/${workflowId}/recover`,
          headers: authorization,
        })
      ).statusCode,
    ).toBe(403);

    const writer = await app(["workflow.write"]);

    const recover = vi.spyOn(writer.workflowRunner, "recover");

    expect(
      (
        await writer.instance.inject({
          method: "POST",
          url: `/api/v1/workflows/${workflowId}/recover`,
          headers: authorization,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);

    expect(recover).toHaveBeenCalledWith(
      actorId,
      workflowId,
      expect.objectContaining({
        actorId,
      }),
      expect.any(String),
    );

    expect(
      (
        await writer.instance.inject({
          method: "POST",
          url: `/api/v1/workflows/${workflowId}/recover`,
          headers: authorization,
          payload: {
            retry: true,
          },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("requires explicit bounded ambiguity resolution", async () => {
    const workflows = store();

    const resolveAmbiguousOwned = vi.spyOn(workflows, "resolveAmbiguousOwned");

    const { instance } = await app(["workflow.write"], workflows);

    const response = await instance.inject({
      method: "POST",
      url: `/api/v1/workflows/${workflowId}/resolve-ambiguity`,
      headers: authorization,
      payload: {
        resolution: "CONFIRMED_NOT_EXECUTED",
      },
    });

    expect(response.statusCode).toBe(200);

    expect(resolveAmbiguousOwned).toHaveBeenCalledWith(
      actorId,
      workflowId,
      "CONFIRMED_NOT_EXECUTED",
    );

    expect(response.json()).toMatchObject({
      workflow: {
        id: workflowId,
        status: "FAILED",
      },
    });
  });

  it("accepts only the two supported ambiguity decisions", async () => {
    const { instance } = await app(["workflow.write"]);

    for (const payload of [
      {},
      {
        resolution: "RETRY",
      },
      {
        resolution: "CONFIRMED_EXECUTED",
        retry: true,
      },
      {
        actorId,
        resolution: "CONFIRMED_NOT_EXECUTED",
      },
      {
        result: {
          messageId: "forged",
        },
        resolution: "CONFIRMED_EXECUTED",
      },
    ]) {
      expect(
        (
          await instance.inject({
            method: "POST",
            url: `/api/v1/workflows/${workflowId}/resolve-ambiguity`,
            headers: authorization,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }

    expect(
      (
        await instance.inject({
          method: "POST",
          url: `/api/v1/workflows/${workflowId}/resolve-ambiguity`,
          headers: authorization,
          payload: {
            resolution: "CONFIRMED_EXECUTED",
          },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("derives actor ownership and bounds list limits", async () => {
    const workflows = store();

    const listOwned = vi.spyOn(workflows, "listOwned");

    const { instance } = await app(["workflow.read"], workflows);

    expect(
      (
        await instance.inject({
          method: "GET",
          url: "/api/v1/workflows?limit=50",
          headers: authorization,
        })
      ).statusCode,
    ).toBe(200);

    expect(listOwned).toHaveBeenCalledWith(actorId, 50);

    expect(
      (
        await instance.inject({
          method: "GET",
          url: "/api/v1/workflows?limit=51",
          headers: authorization,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("returns safe detail without actor or internal step IDs", async () => {
    const { instance } = await app(["workflow.read"]);

    const response = await instance.inject({
      method: "GET",
      url: `/api/v1/workflows/${workflowId}`,
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);

    expect(response.json()).toEqual({
      workflow: snapshot,
    });

    expect(response.body).not.toContain("actorId");
    expect(response.body).not.toContain("providerToken");
  });

  it("rejects invalid IDs and cancellation authority fields", async () => {
    const { instance } = await app(["workflow.write"]);

    expect(
      (
        await instance.inject({
          method: "POST",
          url: "/api/v1/workflows/not-a-uuid/cancel",
          headers: authorization,
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (
        await instance.inject({
          method: "POST",
          url: `/api/v1/workflows/${workflowId}/cancel`,
          headers: authorization,
          payload: {
            status: "COMPLETED",
            actorId,
          },
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (
        await instance.inject({
          method: "POST",
          url: "/api/v1/workflows/not-a-uuid/resolve-ambiguity",
          headers: authorization,
          payload: {
            resolution: "CONFIRMED_NOT_EXECUTED",
          },
        })
      ).statusCode,
    ).toBe(400);
  });
});
