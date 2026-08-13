import { describe, expect, it, vi } from "vitest";

import { createAgentServiceClient } from "../src/clients/agent/agent-service-client.js";
import { testConfig } from "./test-config.js";

const validBody = {
  requestId: "request-1",
  intent: "propose_tool",
  response: "I can propose the echo tool for that request.",
  plan: {
    type: "tool",
    tool: { name: "system.echo", input: { message: "hello" } },
  },
};

describe("Agent Service client", () => {
  it("authenticates, propagates correlation, and validates the result", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(validBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const result = await createAgentServiceClient(
      testConfig,
      fetchMock,
    ).respond({ message: "echo hello" }, "request-1");
    expect(result.plan.type).toBe("tool");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-request-id": "request-1",
      "x-aura-service-id": "gateway",
      "x-aura-service-token": testConfig.agentService.token,
    });
  });

  it.each([
    new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify({ ...validBody, requestId: "wrong" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify({ ...validBody, plan: { type: "execute" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ])("fails closed for malformed upstream responses", async (response) => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response));
    await expect(
      createAgentServiceClient(testConfig, fetchMock).respond(
        { message: "hello" },
        "request-1",
      ),
    ).rejects.toMatchObject({
      code: "UPSTREAM_PROTOCOL_ERROR",
      httpStatus: 502,
    });
  });

  it("maps unavailability and timeouts", async () => {
    const unavailable = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError("refused")),
    );
    await expect(
      createAgentServiceClient(testConfig, unavailable).respond(
        { message: "hello" },
        "request-1",
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_SERVICE_UNAVAILABLE" });

    const timeout = vi.fn<typeof fetch>(() =>
      Promise.reject(new DOMException("timed out", "TimeoutError")),
    );
    await expect(
      createAgentServiceClient(testConfig, timeout).respond(
        { message: "hello" },
        "request-1",
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_SERVICE_TIMEOUT" });
  });
});
