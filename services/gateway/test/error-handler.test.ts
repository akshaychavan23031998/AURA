import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app/create-app.js";
import { AppError } from "../src/errors/app-error.js";
import type { ErrorResponse } from "../src/errors/error-response.js";
import { testConfig } from "./test-config.js";

describe("external error contract", () => {
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it("returns a stable not-found response", async () => {
    const app = await createApp({ config: testConfig, logger: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/unknown" });
    const body = response.json<ErrorResponse>();

    expect(response.statusCode).toBe(404);
    expect(body).toEqual({
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "Route not found",
        requestId: response.headers["x-request-id"],
      },
    });
  });

  it("does not expose unexpected error details or stack traces", async () => {
    const app = await createApp({ config: testConfig, logger: false });
    apps.push(app);
    app.get("/test/internal-error", () => {
      throw new Error("sensitive implementation detail");
    });

    const response = await app.inject({
      method: "GET",
      url: "/test/internal-error",
    });
    const body = response.json<ErrorResponse>();

    expect(response.statusCode).toBe(500);
    expect(body).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
        requestId: response.headers["x-request-id"],
      },
    });
    expect(response.body).not.toContain("sensitive implementation detail");
    expect(response.body).not.toContain("stack");
  });

  it("maps typed application errors without exposing their cause", async () => {
    const app = await createApp({ config: testConfig, logger: false });
    apps.push(app);
    app.get("/test/app-error", () => {
      throw new AppError({
        code: "DEPENDENCY_UNAVAILABLE",
        httpStatus: 503,
        message: "Service unavailable",
        cause: new Error("private cause"),
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/test/app-error",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "DEPENDENCY_UNAVAILABLE", message: "Service unavailable" },
    });
    expect(response.body).not.toContain("private cause");
  });

  it("sets baseline security headers", async () => {
    const app = await createApp({ config: testConfig, logger: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});
