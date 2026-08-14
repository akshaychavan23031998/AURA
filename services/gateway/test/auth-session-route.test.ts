import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app/create-app.js";
import { InvalidSessionError } from "../src/identity/session-service.js";
import {
  testAuthorizationHeader,
  testTokenVerifier,
} from "./auth-test-helpers.js";
import { testConfig } from "./test-config.js";

function manager() {
  return {
    create: vi.fn(),
    createDevelopmentSession: vi.fn().mockResolvedValue({
      accessToken: "dev.access.token",
      refreshToken: "d".repeat(43),
    }),
    rotate: vi.fn().mockResolvedValue({
      accessToken: "new.access.token",
      refreshToken: "r".repeat(43),
    }),
    revoke: vi.fn().mockResolvedValue(undefined),
    isActive: vi.fn().mockResolvedValue(true),
  };
}

describe("identity session routes", () => {
  it("rotates a body-authenticated refresh token", async () => {
    const sessions = manager();
    const app = await createApp({
      config: testConfig,
      logger: false,
      sessionService: sessions,
      tokenVerifier: testTokenVerifier,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: "r".repeat(43) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({
      accessToken: "new.access.token",
      refreshToken: "r".repeat(43),
    });
    expect(sessions.rotate).toHaveBeenCalledWith("r".repeat(43));
    await app.close();
  });

  it("maps invalid, expired, revoked, or reused refresh evidence to one 401", async () => {
    const sessions = manager();
    sessions.rotate.mockRejectedValueOnce(new InvalidSessionError());
    const app = await createApp({
      config: testConfig,
      logger: false,
      sessionService: sessions,
      tokenVerifier: testTokenVerifier,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { "x-request-id": "refresh-failure-1" },
      payload: { refreshToken: "r".repeat(43) },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<unknown>()).toMatchObject({
      error: { code: "UNAUTHENTICATED", requestId: "refresh-failure-1" },
    });
    await app.close();
  });

  it("rotates a browser cookie without exposing its replacement to JavaScript", async () => {
    const sessions = manager();
    const app = await createApp({
      config: testConfig,
      logger: false,
      sessionService: sessions,
      tokenVerifier: testTokenVerifier,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: {
        cookie: `aura_refresh=${"r".repeat(43)}`,
        origin: testConfig.browser.origin,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({
      accessToken: "new.access.token",
    });
    expect(cookieHeaders(response.headers["set-cookie"])).toContain("HttpOnly");
    expect(cookieHeaders(response.headers["set-cookie"])).toContain(
      "SameSite=Strict",
    );
    expect(cookieHeaders(response.headers["set-cookie"])).not.toContain(
      "Secure",
    );
    await app.close();
  });

  it("rejects a cookie-backed mutation from an untrusted origin", async () => {
    const app = await createApp({
      config: testConfig,
      logger: false,
      sessionService: manager(),
      tokenVerifier: testTokenVerifier,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: {
        cookie: `aura_refresh=${"r".repeat(43)}`,
        origin: "https://attacker.invalid",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<unknown>()).toMatchObject({
      error: { code: "INVALID_ORIGIN" },
    });
    await app.close();
  });

  it("keeps development session creation unavailable outside development", async () => {
    const sessions = manager();
    const app = await createApp({
      config: testConfig,
      logger: false,
      sessionService: sessions,
      tokenVerifier: testTokenVerifier,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/development-session",
      headers: { origin: testConfig.browser.origin },
    });
    expect(response.statusCode).toBe(404);
    expect(sessions.createDevelopmentSession).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates only the server-controlled development identity when explicitly enabled", async () => {
    const sessions = manager();
    const app = await createApp({
      config: {
        ...testConfig,
        runtime: { environment: "development" },
        browser: {
          ...testConfig.browser,
          developmentSessionEnabled: true,
        },
      },
      logger: false,
      sessionService: sessions,
      tokenVerifier: testTokenVerifier,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/development-session",
      headers: { origin: testConfig.browser.origin },
      payload: { userId: "attacker-controlled", permissions: ["*"] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({
      accessToken: "dev.access.token",
    });
    expect(sessions.createDevelopmentSession).toHaveBeenCalledWith();
    expect(cookieHeaders(response.headers["set-cookie"])).toContain("HttpOnly");
    await app.close();
  });

  it("performs idempotent authenticated logout by sid and sub", async () => {
    const sessions = manager();
    const app = await createApp({
      config: testConfig,
      logger: false,
      sessionService: sessions,
      tokenVerifier: testTokenVerifier,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: testAuthorizationHeader,
    });
    expect(response.statusCode).toBe(204);
    expect(sessions.revoke).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "local-user-001",
    );
    expect(cookieHeaders(response.headers["set-cookie"])).toContain(
      "Max-Age=0",
    );
    await app.close();
  });
});

function cookieHeaders(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join("\n") : (value ?? "");
}
