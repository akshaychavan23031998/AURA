import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app/create-app.js";
import { parseBearerAuthorization } from "../src/auth/auth-plugin.js";
import { issueAccessToken } from "../src/auth/token-issuer.js";
import { createAccessTokenVerifier } from "../src/auth/token-verifier.js";
import { testConfig } from "./test-config.js";

const now = Math.floor(Date.now() / 1000);
const sessionId = "00000000-0000-4000-8000-000000000001";

describe("bearer authorization parser", () => {
  it("accepts exactly one Bearer JWT", () => {
    expect(parseBearerAuthorization("Bearer one.two.three")).toBe(
      "one.two.three",
    );
  });

  it.each([
    undefined,
    "",
    "Basic one.two.three",
    "Token one.two.three",
    "Bearer ",
    "bearer one.two.three",
    "Bearer one.two.three extra",
    ["Bearer one.two.three", "Bearer four.five.six"],
    `Bearer ${"a".repeat(4097)}.b.c`,
  ])("rejects malformed credentials", (header) => {
    expect(() => parseBearerAuthorization(header)).toThrowError(
      expect.objectContaining({ code: "UNAUTHENTICATED" }),
    );
  });
});

describe("access-token verification", () => {
  const verifier = createAccessTokenVerifier(testConfig);

  it("creates an immutable trusted principal from a valid token", async () => {
    const token = await issueAccessToken(
      testConfig.auth,
      "local-user-001",
      sessionId,
      ["system.echo"],
      now,
    );
    const principal = await verifier.verify(token);
    expect(principal).toMatchObject({
      actorId: "local-user-001",
      permissions: ["system.echo"],
      tokenIssuedAt: now,
      tokenExpiresAt: now + 900,
    });
    expect(principal.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.permissions)).toBe(true);
  });

  it.each([
    [
      "invalid signature",
      { secret: "different-signing-secret-at-least-32-characters" },
    ],
    ["expired", { issuedAt: now - 1000, expiresAt: now - 100 }],
    ["wrong issuer", { issuer: "not-aura" }],
    ["wrong audience", { audience: "not-aura-api" }],
    ["missing subject", { subject: null }],
    ["unsafe subject", { subject: "invalid subject" }],
    ["unknown permission", { permissions: ["admin.*"] }],
    ["future issued-at", { issuedAt: now + 100, expiresAt: now + 1000 }],
  ])("rejects %s", async (_name, overrides) => {
    const token = await signToken(overrides);
    await expect(verifier.verify(token)).rejects.toBeDefined();
  });

  it("rejects an unsigned token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({
        sub: "local-user-001",
        iss: testConfig.auth.issuer,
        aud: testConfig.auth.audience,
        iat: now,
        exp: now + 900,
        permissions: ["system.echo"],
        tokenVersion: 1,
      }),
    ).toString("base64url");
    await expect(
      verifier.verify(`${header}.${payload}.`),
    ).rejects.toBeDefined();
  });

  it("issues controlled, bounded session-bound tokens", async () => {
    const token = await issueAccessToken(
      testConfig.auth,
      "developer-001",
      sessionId,
      undefined,
      now,
    );
    await expect(verifier.verify(token)).resolves.toMatchObject({
      actorId: "developer-001",
      permissions: ["system.echo"],
      tokenExpiresAt: now + 900,
    });
  });
});

describe("protected routes", () => {
  it.each([
    "/api/v1/agent/respond",
    "/api/v1/agent/run",
    "/api/v1/tools/execute",
  ])("returns one safe 401 contract for missing auth on %s", async (url) => {
    const app = await createApp({ config: testConfig, logger: false });
    const response = await app.inject({
      method: "POST",
      url,
      headers: { "x-request-id": "auth-failure-1" },
      payload: { message: "hello" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["x-request-id"]).toBe("auth-failure-1");
    expect(response.json<unknown>()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication required",
        requestId: "auth-failure-1",
      },
    });
    await app.close();
  });

  it("does not expose an invalid token in the error", async () => {
    const app = await createApp({ config: testConfig, logger: false });
    const token = "invalid.token.value";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/run",
      headers: { authorization: `Bearer ${token}` },
      payload: { message: "hello" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(token);
    await app.close();
  });
});

interface TokenOverrides {
  readonly secret?: string;
  readonly subject?: string | null;
  readonly issuer?: string;
  readonly audience?: string;
  readonly permissions?: readonly string[];
  readonly issuedAt?: number;
  readonly expiresAt?: number;
  readonly sessionId?: string;
}

async function signToken(overrides: TokenOverrides): Promise<string> {
  let token = new SignJWT({
    permissions: overrides.permissions ?? ["system.echo"],
    tokenVersion: 1,
    sid: overrides.sessionId ?? sessionId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(overrides.issuer ?? testConfig.auth.issuer)
    .setAudience(overrides.audience ?? testConfig.auth.audience)
    .setIssuedAt(overrides.issuedAt ?? now)
    .setExpirationTime(overrides.expiresAt ?? now + 900);
  if (overrides.subject !== null) {
    token = token.setSubject(overrides.subject ?? "local-user-001");
  }
  return token.sign(
    new TextEncoder().encode(overrides.secret ?? testConfig.auth.secret),
  );
}
