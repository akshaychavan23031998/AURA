import { afterEach, describe, expect, it } from "vitest";

import { createApp as createToolApp } from "../../tools/src/app/create-app.js";
import type { ToolsConfig } from "../../tools/src/config/index.js";
import { createApp as createGatewayApp } from "../src/app/create-app.js";
import type { GatewayConfig } from "../src/config/index.js";
import { issueAccessToken } from "../src/auth/token-issuer.js";
import { createAccessTokenVerifier } from "../src/auth/token-verifier.js";

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
      voiceService: {
        url: "http://127.0.0.1:8002",
        token: "voice-test-token-at-least-32-characters",
        timeoutMs: 1000,
        maxAudioBytes: 10485760,
      },
      voiceStream: {
        frameBytes: 640,
        maxFrameBytes: 640,
        maxBufferBytes: 960000,
        maxUtteranceMs: 30000,
        audioChunkBytes: 16384,
        vadThreshold: 500,
        vadMinSpeechMs: 100,
        vadEndSilenceMs: 600,
        frameMs: 20,
        idleTimeoutMs: 120000,
        bargeInEnabled: true,
        bargeInMinSpeechMs: 100,
        interruptSettleTimeoutMs: 5000,
      },
      auth: {
        secret: "gateway-jwt-test-secret-at-least-32-characters",
        issuer: "aura-gateway",
        audience: "aura-api",
        accessTokenTtlSeconds: 900,
        sessionTtlSeconds: 604_800,
      },
      browser: {
        origin: "http://localhost:3000",
        secureCookies: false,
        developmentSessionEnabled: false,
      },
      googleOidc: { enabled: false },
      database: { url: "postgresql://aura:aura@127.0.0.1:5432/aura_test" },
    };
    const gatewayApp = await createGatewayApp({
      config: gatewayConfig,
      logger: false,
      tokenVerifier: createAccessTokenVerifier(gatewayConfig),
    });
    closeables.push(gatewayApp);

    const accessToken = await issueAccessToken(
      gatewayConfig.auth,
      "contract-user-1",
      "00000000-0000-4000-8000-000000000001",
    );
    const response = await gatewayApp.inject({
      method: "POST",
      url: "/api/v1/tools/execute",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-request-id": "contract-request-1",
      },
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
