import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app/create-app.js";
import { AppError } from "../src/errors/app-error.js";
import type { ToolServiceClient } from "../src/clients/tools/tool-service-client.js";
import type { ErrorResponse } from "../src/errors/error-response.js";
import { testConfig } from "./test-config.js";

describe("public tool execution route", () => {
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];
  afterEach(async () =>
    Promise.all(apps.splice(0).map(async (app) => app.close())),
  );

  async function app(client: ToolServiceClient) {
    const instance = await createApp({
      config: testConfig,
      logger: false,
      toolClient: client,
    });
    apps.push(instance);
    return instance;
  }

  it("derives trusted local context and propagates the request ID", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        status: "success" as const,
        tool: "system.echo",
        data: { message: "hello" },
      }),
    );
    const response = await (
      await app({ execute })
    ).inject({
      method: "POST",
      url: "/api/v1/tools/execute",
      headers: { "x-request-id": "public-request-1" },
      payload: { tool: "system.echo", input: { message: "hello" } },
    });
    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      { tool: "system.echo", input: { message: "hello" } },
      { actorId: "local-dev-user", grantedPermissions: ["system.echo"] },
      "public-request-1",
    );
    expect(response.headers["x-request-id"]).toBe("public-request-1");
  });

  it("rejects external attempts to self-grant context", async () => {
    const execute = vi.fn<ToolServiceClient["execute"]>();
    const response = await (
      await app({ execute })
    ).inject({
      method: "POST",
      url: "/api/v1/tools/execute",
      payload: {
        tool: "system.echo",
        input: { message: "hello" },
        context: { actorId: "attacker", grantedPermissions: ["admin.*"] },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe("VALIDATION_ERROR");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["TOOL_NOT_FOUND", 404],
    ["PERMISSION_DENIED", 403],
    ["APPROVAL_REQUIRED", 409],
    ["UPSTREAM_SERVICE_UNAVAILABLE", 502],
    ["UPSTREAM_SERVICE_TIMEOUT", 504],
    ["UPSTREAM_PROTOCOL_ERROR", 502],
  ])("preserves safe mapped error %s", async (code, status) => {
    const client: ToolServiceClient = {
      execute: () =>
        Promise.reject(
          new AppError({ code, httpStatus: status, message: "Safe error" }),
        ),
    };
    const response = await (
      await app(client)
    ).inject({
      method: "POST",
      url: "/api/v1/tools/execute",
      payload: { tool: "does.not.exist", input: {} },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json<ErrorResponse>().error.code).toBe(code);
  });
});
