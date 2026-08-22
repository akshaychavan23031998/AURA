import { describe, expect, it, vi } from "vitest";

import { WorkflowApi } from "./workflow-api";

const baseUrl = new URL("http://gateway.test/");

const workflowId = "00000000-0000-4000-8000-000000000100";

const summary = {
  id: workflowId,
  goal: "Prepare for meeting",
  status: "READY" as const,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
  cancelledAt: null,
  startedAt: null,
  completedAt: null,
};

const workflow = {
  ...summary,
  steps: [
    {
      stepKey: "calendar",
      kind: "tool" as const,
      ordinal: 0,
      status: "READY" as const,
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("WorkflowApi", () => {
  it("lists workflows with a bounded limit query", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(jsonResponse({ workflows: [summary] }));

    const api = new WorkflowApi({ request }, baseUrl);

    await expect(api.list(25)).resolves.toEqual([summary]);

    expect(request).toHaveBeenCalledOnce();

    const [url, init] = request.mock.calls[0] ?? [];

    expect(url).toBeInstanceOf(URL);
    expect((url as URL).pathname).toBe("/api/v1/workflows");
    expect((url as URL).searchParams.get("limit")).toBe("25");
    expect(init).toBeUndefined();
  });

  it("uses the default list limit", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ workflows: [] }));

    const api = new WorkflowApi({ request }, baseUrl);

    await expect(api.list()).resolves.toEqual([]);

    const [url] = request.mock.calls[0] ?? [];

    expect((url as URL).searchParams.get("limit")).toBe("20");
  });

  it("gets one workflow using its server-issued identifier", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ workflow }));

    const api = new WorkflowApi({ request }, baseUrl);

    await expect(api.get(workflowId)).resolves.toEqual(workflow);

    const [url, init] = request.mock.calls[0] ?? [];

    expect((url as URL).pathname).toBe(`/api/v1/workflows/${workflowId}`);
    expect(init).toBeUndefined();
  });

  it.each(["run", "recover", "cancel"] as const)(
    "sends %s as a bodyless explicit POST mutation",
    async (action) => {
      const responseWorkflow =
        action === "cancel"
          ? {
              ...workflow,
              status: "CANCELLED" as const,
              cancelledAt: "2026-08-21T01:00:00.000Z",
            }
          : workflow;

      const request = vi.fn().mockResolvedValue(
        jsonResponse({
          workflow: responseWorkflow,
        }),
      );

      const api = new WorkflowApi({ request }, baseUrl);

      await expect(api[action](workflowId)).resolves.toEqual(responseWorkflow);

      expect(request).toHaveBeenCalledOnce();

      const [url, init] = request.mock.calls[0] ?? [];

      expect((url as URL).pathname).toBe(
        `/api/v1/workflows/${workflowId}/${action}`,
      );

      expect(init).toEqual({
        method: "POST",
      });

      expect(init).not.toHaveProperty("body");
      expect(init).not.toHaveProperty("headers");
    },
  );

  it("encodes workflow identifiers before placing them in URLs", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ workflow }));

    const api = new WorkflowApi({ request }, baseUrl);

    await api.get("workflow/id");

    const [url] = request.mock.calls[0] ?? [];

    expect((url as URL).pathname).toBe("/api/v1/workflows/workflow%2Fid");
  });

  it("fails closed when the Gateway returns an invalid workflow payload", async () => {
    const request = vi.fn().mockResolvedValue(
      jsonResponse({
        workflow: {
          ...workflow,
          actorId: "attacker-controlled",
        },
      }),
    );

    const api = new WorkflowApi({ request }, baseUrl);

    await expect(api.get(workflowId)).rejects.toThrow(
      "Invalid workflow response",
    );
  });

  it("rejects workflow responses containing raw execution results", async () => {
    const request = vi.fn().mockResolvedValue(
      jsonResponse({
        workflow: {
          ...workflow,
          steps: [
            {
              ...workflow.steps[0],
              result: {
                token: "must-not-reach-browser",
              },
            },
          ],
        },
      }),
    );

    const api = new WorkflowApi({ request }, baseUrl);

    await expect(api.get(workflowId)).rejects.toThrow(
      "Invalid workflow response",
    );
  });
});
