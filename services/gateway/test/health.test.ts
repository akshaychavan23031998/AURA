import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app/create-app.js";
import { testConfig } from "./test-config.js";

describe("operational endpoints", () => {
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it("reports liveness", async () => {
    const app = await createApp({
      config: testConfig,
      logger: false,
      database: {
        db: {} as never,
        check: () => Promise.resolve(),
        close: () => Promise.resolve(),
      },
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "gateway" });
    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("reports readiness after successful initialization", async () => {
    const app = await createApp({
      config: testConfig,
      logger: false,
      database: {
        db: {} as never,
        check: () => Promise.resolve(),
        close: () => Promise.resolve(),
      },
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", service: "gateway" });
  });

  it("preserves a safe client correlation ID", async () => {
    const app = await createApp({ config: testConfig, logger: false });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "client-request_123" },
    });

    expect(response.headers["x-request-id"]).toBe("client-request_123");
  });

  it("replaces an unsafe client correlation ID", async () => {
    const app = await createApp({ config: testConfig, logger: false });
    apps.push(app);
    const unsafeId = `bad id ${"x".repeat(200)}`;

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": unsafeId },
    });

    expect(response.headers["x-request-id"]).not.toBe(unsafeId);
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
