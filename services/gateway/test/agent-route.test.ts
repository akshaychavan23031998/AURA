import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app/create-app.js";
import type { AgentServiceClient } from "../src/clients/agent/agent-service-client.js";
import type { ToolServiceClient } from "../src/clients/tools/tool-service-client.js";
import { testConfig } from "./test-config.js";
import {
  testAuthorizationHeader,
  testTokenVerifier,
} from "./auth-test-helpers.js";

function createClient(): {
  client: AgentServiceClient;
  respond: ReturnType<typeof vi.fn<AgentServiceClient["respond"]>>;
} {
  const respond = vi.fn<AgentServiceClient["respond"]>((_, requestId) =>
    Promise.resolve({
      requestId,
      intent: "respond",
      response: "Agent planning foundation is active.",
      plan: { type: "respond" as const },
    }),
  );
  return { client: { respond }, respond };
}

describe("POST /api/v1/agent/respond", () => {
  it("forwards the public request and returns the plan", async () => {
    const { client: agentClient, respond } = createClient();
    const app = await createApp({
      config: testConfig,
      agentClient,
      tokenVerifier: testTokenVerifier,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/respond",
      headers: { ...testAuthorizationHeader, "x-request-id": "request-1" },
      payload: { message: "hello", locale: "en-IN" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toMatchObject({
      plan: { type: "respond" },
    });
    expect(respond).toHaveBeenCalledWith(
      { message: "hello", locale: "en-IN" },
      "request-1",
    );
    await app.close();
  });

  it("rejects privileged fields before calling the Agent", async () => {
    const { client: agentClient, respond } = createClient();
    const app = await createApp({
      config: testConfig,
      agentClient,
      tokenVerifier: testTokenVerifier,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/respond",
      headers: testAuthorizationHeader,
      payload: {
        message: "echo hello",
        grantedPermissions: ["system.echo"],
        execute: true,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<unknown>()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect(respond).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("POST /api/v1/agent/run", () => {
  it("returns a direct user-oriented response with request correlation", async () => {
    const { client: agentClient, respond } = createClient();
    const execute = vi.fn<ToolServiceClient["execute"]>();
    const toolClient: ToolServiceClient = { execute };
    const app = await createApp({
      config: testConfig,
      agentClient,
      toolClient,
      tokenVerifier: testTokenVerifier,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/run",
      headers: {
        ...testAuthorizationHeader,
        "x-request-id": "orchestration-route-1",
      },
      payload: { message: "hello" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("orchestration-route-1");
    expect(response.json<unknown>()).toEqual({
      status: "completed",
      response: { text: "Agent planning foundation is active." },
      steps: 1,
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [{ message: "" }],
    [{ message: "hello", actorId: "attacker" }],
    [{ message: "hello", grantedPermissions: ["system.echo"] }],
    [
      {
        message: "hello",
        toolResult: { tool: "system.echo", status: "success", data: {} },
      },
    ],
    [{ message: "hello", orchestrationState: { step: 2 } }],
  ])("rejects an invalid or privileged public body", async (payload) => {
    const { client: agentClient, respond } = createClient();
    const execute = vi.fn<ToolServiceClient["execute"]>();
    const app = await createApp({
      config: testConfig,
      agentClient,
      toolClient: { execute },
      tokenVerifier: testTokenVerifier,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/run",
      headers: testAuthorizationHeader,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<unknown>()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect(respond).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });
});
