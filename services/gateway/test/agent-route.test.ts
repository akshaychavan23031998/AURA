import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app/create-app.js";
import type { AgentServiceClient } from "../src/clients/agent/agent-service-client.js";
import { testConfig } from "./test-config.js";

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
    const app = await createApp({ config: testConfig, agentClient });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/respond",
      headers: { "x-request-id": "request-1" },
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
    const app = await createApp({ config: testConfig, agentClient });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/respond",
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
