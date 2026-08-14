import { describe, expect, it, vi } from "vitest";

import { createToolServiceClient } from "../src/clients/tools/tool-service-client.js";
import { testConfig } from "./test-config.js";

const request = { tool: "system.echo", input: { message: "hello" } };
const context = {
  actorId: "tool-client-test-user",
  grantedPermissions: ["system.echo"],
};

describe("Tool Service client", () => {
  it("resolves Calendar credentials by trusted actor and forwards only internally", async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValue("short-lived-google-access-token");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "success",
        tool: "calendar.events.list",
        version: 1,
        data: { events: [] },
      }),
    );
    await createToolServiceClient(testConfig, fetchMock, undefined, {
      getAccessToken,
    }).execute(
      {
        tool: "calendar.events.list",
        input: {
          timeMin: "2026-08-14T00:00:00Z",
          timeMax: "2026-08-15T00:00:00Z",
        },
      },
      {
        actorId: "trusted-actor",
        grantedPermissions: ["calendar.events.read"],
      },
      "calendar-request-1",
    );
    expect(getAccessToken).toHaveBeenCalledWith("trusted-actor", undefined);
    const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof rawBody).toBe("string");
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as {
      context: { providerAccessToken?: string };
      input: Record<string, unknown>;
    };
    expect(body.context.providerAccessToken).toBe(
      "short-lived-google-access-token",
    );
    expect(body.input).not.toHaveProperty("providerAccessToken");
  });

  it.each([
    "calendar.events.create",
    "calendar.events.update",
    "calendar.events.delete",
  ])(
    "requires the Calendar event-write provider scope for %s",
    async (tool) => {
      const getAccessToken = vi.fn().mockResolvedValue("provider-access-token");
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          status: "success",
          tool,
          version: 1,
          data: { event: { eventId: "event-1" } },
        }),
      );
      await createToolServiceClient(testConfig, fetchMock, undefined, {
        getAccessToken,
      }).execute(
        { tool, input: {} },
        {
          actorId: "trusted-actor",
          grantedPermissions: ["calendar.events.write"],
        },
        "calendar-create-1",
      );
      expect(getAccessToken).toHaveBeenCalledWith(
        "trusted-actor",
        "https://www.googleapis.com/auth/calendar.events",
      );
    },
  );

  it("authenticates, propagates correlation, and validates success", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: "success",
            tool: "system.echo",
            version: 1,
            data: { message: "hello" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const result = await createToolServiceClient(testConfig, fetchMock).execute(
      request,
      context,
      "request-1",
    );
    expect(result.data).toEqual({ message: "hello" });
    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.headers).toMatchObject({
      "x-request-id": "request-1",
      "x-aura-service-id": "gateway",
      "x-aura-service-token": testConfig.toolsService.token,
    });
  });

  it("resolves Gmail tokens with the exact read-only provider scope", async () => {
    const getAccessToken = vi.fn().mockResolvedValue("gmail-access-token");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "success",
        tool: "gmail.messages.list",
        version: 1,
        data: { messages: [] },
      }),
    );
    await createToolServiceClient(testConfig, fetchMock, undefined, {
      getAccessToken,
    }).execute(
      { tool: "gmail.messages.list", input: { maxResults: 10 } },
      { actorId: "trusted-actor", grantedPermissions: ["gmail.messages.read"] },
      "gmail-request-1",
    );
    expect(getAccessToken).toHaveBeenCalledWith(
      "trusted-actor",
      "https://www.googleapis.com/auth/gmail.readonly",
    );
  });

  it("resolves the narrow Gmail send scope for outbound messages", async () => {
    const tool = "gmail.messages.send";
    const getAccessToken = vi.fn().mockResolvedValue("gmail-access-token");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "success",
        tool,
        version: 1,
        data: { messageId: "sent-1", threadId: "thread-1", sent: true },
      }),
    );
    await createToolServiceClient(testConfig, fetchMock, undefined, {
      getAccessToken,
    }).execute(
      { tool, input: {} },
      {
        actorId: "trusted-actor",
        grantedPermissions: ["gmail.messages.send"],
      },
      "gmail-send-request",
    );
    expect(getAccessToken).toHaveBeenCalledWith(
      "trusted-actor",
      "https://www.googleapis.com/auth/gmail.send",
    );
  });

  it("requires both Gmail read and send scopes before replying", async () => {
    const getAccessToken = vi.fn().mockResolvedValue("gmail-access-token");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "success",
        tool: "gmail.messages.reply",
        version: 1,
        data: { messageId: "reply-1", threadId: "thread-1", sent: true },
      }),
    );
    await createToolServiceClient(testConfig, fetchMock, undefined, {
      getAccessToken,
    }).execute(
      { tool: "gmail.messages.reply", input: {} },
      {
        actorId: "trusted-actor",
        grantedPermissions: ["gmail.messages.send"],
      },
      "gmail-reply-request",
    );
    expect(getAccessToken).toHaveBeenCalledWith("trusted-actor", [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ]);
  });

  it("maps trusted Tool errors without raw downstream messages", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "TOOL_NOT_FOUND",
              message: "internal text",
              requestId: "request-1",
            },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    await expect(
      createToolServiceClient(testConfig, fetchMock).execute(
        request,
        context,
        "request-1",
      ),
    ).rejects.toMatchObject({
      code: "TOOL_NOT_FOUND",
      httpStatus: 404,
      message: "Tool not found",
    });
  });

  it.each([
    [
      "invalid JSON",
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ],
    [
      "wrong schema",
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ],
    [
      "wrong content type",
      new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    ],
  ])("fails closed for %s", async (_name, response) => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response));
    await expect(
      createToolServiceClient(testConfig, fetchMock).execute(
        request,
        context,
        "request-1",
      ),
    ).rejects.toMatchObject({
      code: "UPSTREAM_PROTOCOL_ERROR",
      httpStatus: 502,
    });
  });

  it("maps unavailable service to 502", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError("connect refused")),
    );
    await expect(
      createToolServiceClient(testConfig, fetchMock).execute(
        request,
        context,
        "request-1",
      ),
    ).rejects.toMatchObject({
      code: "UPSTREAM_SERVICE_UNAVAILABLE",
      httpStatus: 502,
    });
  });

  it("maps an aborted timeout to 504", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.reject(new DOMException("timed out", "TimeoutError")),
    );
    await expect(
      createToolServiceClient(testConfig, fetchMock).execute(
        request,
        context,
        "request-1",
      ),
    ).rejects.toMatchObject({
      code: "UPSTREAM_SERVICE_TIMEOUT",
      httpStatus: 504,
    });
  });
});
