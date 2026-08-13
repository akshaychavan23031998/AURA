import { afterEach, describe, expect, it } from "vitest";

import { createApp as createToolApp } from "../../tools/src/app/create-app.js";
import type { ToolsConfig } from "../../tools/src/config/index.js";
import { createApp as createGatewayApp } from "../src/app/create-app.js";
import type { GatewayConfig } from "../src/config/index.js";

const sharedTestToken = "cross-service-test-token-at-least-32-characters";

describe("Gateway to Tool Service contract", () => {
  const closeables: { close(): Promise<void> }[] = [];
  afterEach(async () =>
    Promise.all(closeables.splice(0).map(async (app) => app.close())),
  );

  it("executes system.echo with one propagated request ID", async () => {
    const toolsConfig: ToolsConfig = {
      runtime: { environment: "test" },
      server: { host: "127.0.0.1", port: 0, bodyLimit: 65_536 },
      logging: { level: "silent" },
      internalAuth: { token: sharedTestToken, allowedServiceId: "gateway" },
    };
    const toolsApp = await createToolApp({
      config: toolsConfig,
      logger: false,
    });
    closeables.push(toolsApp);
    let downstreamRequestId: string | undefined;
    toolsApp.addHook("onRequest", (request, _reply, done) => {
      downstreamRequestId = request.id;
      done();
    });
    const address = await toolsApp.listen({ host: "127.0.0.1", port: 0 });

    const gatewayConfig: GatewayConfig = {
      runtime: { environment: "test" },
      server: { host: "127.0.0.1", port: 0, bodyLimit: 65_536 },
      logging: { level: "silent" },
      toolsService: { url: address, token: sharedTestToken, timeoutMs: 1000 },
      agentService: {
        url: "http://127.0.0.1:8001",
        token: sharedTestToken,
        timeoutMs: 1000,
      },
    };
    const gatewayApp = await createGatewayApp({
      config: gatewayConfig,
      logger: false,
    });
    closeables.push(gatewayApp);

    const response = await gatewayApp.inject({
      method: "POST",
      url: "/api/v1/tools/execute",
      headers: { "x-request-id": "contract-request-1" },
      payload: { tool: "system.echo", input: { message: "AURA" } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "success",
      tool: "system.echo",
      data: { message: "AURA" },
    });
    expect(response.headers["x-request-id"]).toBe("contract-request-1");
    expect(downstreamRequestId).toBe("contract-request-1");
  });
});
