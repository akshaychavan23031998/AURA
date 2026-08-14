import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createApp as createToolApp } from "../../tools/src/app/create-app.js";
import type { ToolsConfig } from "../../tools/src/config/index.js";
import { createApp as createGatewayApp } from "../src/app/create-app.js";
import type { GatewayConfig } from "../src/config/index.js";
import { issueAccessToken } from "../src/auth/token-issuer.js";
import { createAccessTokenVerifier } from "../src/auth/token-verifier.js";

const serviceToken = "orchestration-contract-token-at-least-32-characters";
const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const python = join(
  repositoryRoot,
  "services",
  "agent",
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);

describe("Gateway Agent Tool orchestration contract", () => {
  const closeables: { close(): Promise<void> }[] = [];
  let agentProcess: ChildProcess | undefined;

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map(async (app) => app.close()));
    agentProcess?.kill();
    agentProcess = undefined;
  });

  it("runs Gateway to Agent to Tool to Agent with one request ID", async () => {
    if (!existsSync(python)) {
      throw new Error(
        "Agent virtual environment is missing; create services/agent/.venv first",
      );
    }

    const agentPort = await reservePort();
    let agentLogs = "";
    agentProcess = spawn(python, ["-m", "aura_agent.main"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        APP_ENV: "test",
        AGENT_HOST: "127.0.0.1",
        AGENT_PORT: String(agentPort),
        LOG_LEVEL: "INFO",
        AURA_INTERNAL_SERVICE_TOKEN: serviceToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    agentProcess.stdout?.on("data", (chunk: Buffer) => {
      agentLogs += chunk.toString("utf8");
    });
    agentProcess.stderr?.on("data", (chunk: Buffer) => {
      agentLogs += chunk.toString("utf8");
    });
    await waitUntilHealthy(`http://127.0.0.1:${agentPort}/health`);

    const toolsConfig: ToolsConfig = {
      runtime: { environment: "test" },
      server: { host: "127.0.0.1", port: 0, bodyLimit: 65_536 },
      logging: { level: "silent" },
      internalAuth: { token: serviceToken, allowedServiceId: "gateway" },
    };
    const toolsApp = await createToolApp({
      config: toolsConfig,
      logger: false,
    });
    closeables.push(toolsApp);
    let toolExecutions = 0;
    let toolRequestId: string | undefined;
    toolsApp.addHook("onRequest", (request, _reply, done) => {
      if (request.url === "/tools/execute") {
        toolExecutions += 1;
        toolRequestId = request.id;
      }
      done();
    });
    const toolsUrl = await toolsApp.listen({ host: "127.0.0.1", port: 0 });

    const gatewayConfig: GatewayConfig = {
      runtime: { environment: "test" },
      server: { host: "127.0.0.1", port: 0, bodyLimit: 65_536 },
      logging: { level: "silent" },
      toolsService: { url: toolsUrl, token: serviceToken, timeoutMs: 2000 },
      agentService: {
        url: `http://127.0.0.1:${agentPort}`,
        token: serviceToken,
        timeoutMs: 2000,
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
      "orchestration-user-1",
      "00000000-0000-4000-8000-000000000001",
    );
    const response = await gatewayApp.inject({
      method: "POST",
      url: "/api/v1/agent/run",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-request-id": "orchestration-test-1",
      },
      payload: { message: "echo AURA" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("orchestration-test-1");
    expect(response.json<unknown>()).toEqual({
      status: "completed",
      response: { text: "Echo completed successfully: AURA" },
      steps: 2,
    });
    expect(toolExecutions).toBe(1);
    expect(toolRequestId).toBe("orchestration-test-1");
    expect(agentLogs.match(/"requestId":"orchestration-test-1"/g)).toHaveLength(
      2,
    );

    const noPermissionToken = await issueAccessToken(
      gatewayConfig.auth,
      "no-permission-user",
      "00000000-0000-4000-8000-000000000001",
      [],
    );
    const deniedResponse = await gatewayApp.inject({
      method: "POST",
      url: "/api/v1/agent/run",
      headers: { authorization: `Bearer ${noPermissionToken}` },
      payload: { message: "echo AURA" },
    });
    expect(deniedResponse.statusCode).toBe(403);
    expect(deniedResponse.json<unknown>()).toMatchObject({
      error: { code: "PERMISSION_DENIED" },
    });

    const forgedResponse = await gatewayApp.inject({
      method: "POST",
      url: "/api/v1/agent/run",
      headers: { authorization: `Bearer ${noPermissionToken}` },
      payload: {
        message: "echo AURA",
        actorId: "admin",
        permissions: ["system.echo"],
      },
    });
    expect(forgedResponse.statusCode).toBe(400);
  }, 15_000);
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Unable to reserve an Agent test port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return port;
}

async function waitUntilHealthy(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Startup connection failures are expected until Uvicorn begins listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Agent Service did not become healthy for contract testing");
}
