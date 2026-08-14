import { describe, expect, it, vi } from "vitest";

import { createToolServiceClient } from "../src/clients/tools/tool-service-client.js";
import { testConfig } from "./test-config.js";

const request = { tool: "system.echo", input: { message: "hello" } };
const context = {
  actorId: "tool-client-test-user",
  grantedPermissions: ["system.echo"],
};

describe("Tool Service client", () => {
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
