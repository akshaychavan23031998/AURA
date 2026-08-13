import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app/create-app.js";
import type { ErrorResponse } from "../src/errors/error-response.js";
import { testConfig } from "./test-config.js";

describe("Tool Service HTTP contract", () => {
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function app() {
    const instance = await createApp({ config: testConfig, logger: false });
    apps.push(instance);
    return instance;
  }

  it("reports health, readiness, and request correlation", async () => {
    const instance = await app();
    const health = await instance.inject({ method: "GET", url: "/health" });
    const ready = await instance.inject({ method: "GET", url: "/ready" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok", service: "tools" });
    expect(health.headers["x-request-id"]).toEqual(expect.any(String));
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready", service: "tools" });
  });

  it("lists only safe production tool metadata", async () => {
    const response = await (
      await app()
    ).inject({ method: "GET", url: "/tools" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tools: [
        {
          name: "system.echo",
          description:
            "Returns the supplied message unchanged. Intended for service-contract validation.",
          requiredPermissions: ["system.echo"],
          riskLevel: "READ",
          requiresApproval: false,
        },
      ],
    });
  });

  it("executes system.echo with explicit permission", async () => {
    const response = await (
      await app()
    ).inject({
      method: "POST",
      url: "/tools/execute",
      payload: {
        tool: "system.echo",
        input: { message: "hello" },
        context: { actorId: "local-dev", grantedPermissions: ["system.echo"] },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "success",
      tool: "system.echo",
      data: { message: "hello" },
    });
  });

  it("rejects an unknown tool", async () => {
    const response = await (
      await app()
    ).inject({
      method: "POST",
      url: "/tools/execute",
      payload: {
        tool: "does.not.exist",
        input: {},
        context: { actorId: "local-dev", grantedPermissions: [] },
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorResponse>().error.code).toBe("TOOL_NOT_FOUND");
  });

  it("rejects invalid tool input", async () => {
    const response = await (
      await app()
    ).inject({
      method: "POST",
      url: "/tools/execute",
      payload: {
        tool: "system.echo",
        input: {},
        context: { actorId: "local-dev", grantedPermissions: ["system.echo"] },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe(
      "INVALID_TOOL_INPUT",
    );
  });

  it("rejects missing permission", async () => {
    const response = await (
      await app()
    ).inject({
      method: "POST",
      url: "/tools/execute",
      payload: {
        tool: "system.echo",
        input: { message: "hello" },
        context: { actorId: "local-dev", grantedPermissions: [] },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorResponse>().error.code).toBe("PERMISSION_DENIED");
    expect(response.json<ErrorResponse>().error.requestId).toBe(
      response.headers["x-request-id"],
    );
  });

  it("rejects malformed execution requests", async () => {
    const response = await (
      await app()
    ).inject({
      method: "POST",
      url: "/tools/execute",
      payload: { tool: "system.echo", input: { message: "hello" } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe("VALIDATION_ERROR");
  });

  it("maps malformed JSON to a stable client error", async () => {
    const response = await (
      await app()
    ).inject({
      method: "POST",
      url: "/tools/execute",
      headers: { "content-type": "application/json" },
      payload: '{"tool":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe("VALIDATION_ERROR");
  });

  it("sets security headers", async () => {
    const response = await (
      await app()
    ).inject({ method: "GET", url: "/health" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});
