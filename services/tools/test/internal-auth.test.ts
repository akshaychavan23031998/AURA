import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app/create-app.js";
import type { ErrorResponse } from "../src/errors/error-response.js";
import { testConfig } from "./test-config.js";

describe("internal service authentication", () => {
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];
  afterEach(async () =>
    Promise.all(apps.splice(0).map(async (app) => app.close())),
  );

  async function app() {
    const instance = await createApp({ config: testConfig, logger: false });
    apps.push(instance);
    return instance;
  }

  it("allows health and readiness without internal credentials", async () => {
    const instance = await app();
    expect(
      (await instance.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(200);
    expect(
      (await instance.inject({ method: "GET", url: "/ready" })).statusCode,
    ).toBe(200);
  });

  it.each([
    ["metadata", { method: "GET" as const, url: "/tools" }],
    [
      "execution",
      {
        method: "POST" as const,
        url: "/tools/execute",
        payload: {
          tool: "system.echo",
          input: { message: "hello" },
          context: { actorId: "attacker", grantedPermissions: ["system.echo"] },
        },
      },
    ],
  ])(
    "rejects unauthenticated %s even with body permissions",
    async (_name, options) => {
      const response = await (await app()).inject(options);
      expect(response.statusCode).toBe(401);
      expect(response.json<ErrorResponse>().error.code).toBe(
        "INTERNAL_SERVICE_UNAUTHORIZED",
      );
    },
  );

  it.each([
    [
      "wrong token",
      "gateway",
      "wrong-token-with-at-least-thirty-two-characters",
    ],
    ["wrong identity", "agent", testConfig.internalAuth.token],
  ])(
    "rejects %s without disclosing which credential failed",
    async (_name, serviceId, token) => {
      const response = await (
        await app()
      ).inject({
        method: "GET",
        url: "/tools",
        headers: {
          "x-aura-service-id": serviceId,
          "x-aura-service-token": token,
        },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(token);
      expect(response.json<ErrorResponse>().error.message).toBe(
        "Internal service authentication failed",
      );
    },
  );

  it("allows valid Gateway credentials", async () => {
    const response = await (
      await app()
    ).inject({
      method: "GET",
      url: "/tools",
      headers: {
        "x-aura-service-id": "gateway",
        "x-aura-service-token": testConfig.internalAuth.token,
      },
    });
    expect(response.statusCode).toBe(200);
  });
});
