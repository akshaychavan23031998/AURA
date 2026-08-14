import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app/create-app.js";
import type { ErrorResponse } from "../src/errors/error-response.js";
import { testConfig } from "./test-config.js";

const internalHeaders = {
  "x-aura-service-id": "gateway",
  "x-aura-service-token": testConfig.internalAuth.token,
};

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
    ).inject({ method: "GET", url: "/tools", headers: internalHeaders });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ tools: Record<string, unknown>[] }>();
    expect(body.tools.map((tool) => tool.name)).toEqual([
      "calendar.events.create",
      "calendar.events.delete",
      "calendar.events.get",
      "calendar.events.list",
      "calendar.events.update",
      "gmail.messages.get",
      "gmail.messages.list",
      "system.echo",
      "utility.calculator",
      "utility.datetime",
    ]);
    expect(
      body.tools.find((tool) => tool.name === "utility.calculator"),
    ).toMatchObject({
      version: 1,
      category: "utility",
      requiredPermissions: ["utility.calculator"],
      riskLevel: "READ",
      approvalPolicy: "NONE",
      idempotency: "IDEMPOTENT",
      enabled: true,
    });
    expect(
      body.tools.find((tool) => tool.name === "utility.datetime"),
    ).toMatchObject({
      requiredPermissions: ["utility.datetime"],
      idempotency: "NON_IDEMPOTENT",
    });
  });

  it("returns a sanitized deterministic Agent catalog", async () => {
    const response = await (
      await app()
    ).inject({
      method: "GET",
      url: "/tools/catalog/agent",
      headers: internalHeaders,
    });
    const tools = response.json<{ tools: Record<string, unknown>[] }>().tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "calendar.events.create",
      "calendar.events.delete",
      "calendar.events.get",
      "calendar.events.list",
      "calendar.events.update",
      "gmail.messages.get",
      "gmail.messages.list",
      "system.echo",
      "utility.calculator",
      "utility.datetime",
    ]);
    for (const tool of tools) {
      expect(Object.keys(tool).sort()).toEqual([
        "category",
        "description",
        "inputSchema",
        "name",
      ]);
    }
  });

  it("executes system.echo with explicit permission", async () => {
    const response = await (
      await app()
    ).inject({
      method: "POST",
      url: "/tools/execute",
      headers: internalHeaders,
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
      version: 1,
      data: { message: "hello" },
    });
  });

  it("rejects an unknown tool", async () => {
    const response = await (
      await app()
    ).inject({
      method: "POST",
      url: "/tools/execute",
      headers: internalHeaders,
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
      headers: internalHeaders,
      payload: {
        tool: "system.echo",
        input: {},
        context: { actorId: "local-dev", grantedPermissions: ["system.echo"] },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe(
      "TOOL_INPUT_INVALID",
    );
  });

  it("rejects missing permission", async () => {
    const response = await (
      await app()
    ).inject({
      method: "POST",
      url: "/tools/execute",
      headers: internalHeaders,
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
      headers: internalHeaders,
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
      headers: { "content-type": "application/json", ...internalHeaders },
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
