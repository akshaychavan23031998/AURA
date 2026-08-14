import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app/create-app.js";
import type {
  GoogleOidcProvider,
  OidcTransaction,
} from "../src/identity/google-oidc-client.js";
import type { AuthenticatedExternalIdentity } from "../src/identity/repositories.js";
import { testTokenVerifier } from "./auth-test-helpers.js";
import { testConfig } from "./test-config.js";

const enabledConfig = {
  ...testConfig,
  googleOidc: {
    enabled: true as const,
    clientId: "google-client-id.apps.googleusercontent.com",
    clientSecret: "google-test-secret",
    redirectUri: "http://localhost:4000/api/v1/auth/google/callback",
    transactionTtlSeconds: 600 as const,
  },
};
const identity: AuthenticatedExternalIdentity = {
  provider: "google",
  subject: "google-subject-123",
  email: "person@example.com",
  emailVerified: true,
  displayName: "AURA User",
};

function harness(providerFailure?: Error) {
  let transaction: OidcTransaction | undefined;
  const createAuthorizationUrlMock = vi.fn((value: OidcTransaction) => {
    transaction = value;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: enabledConfig.googleOidc.clientId,
      redirect_uri: enabledConfig.googleOidc.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: value.state,
      nonce: value.nonce,
      code_challenge: "test-pkce-challenge",
      code_challenge_method: "S256",
    }).toString();
    return Promise.resolve(url);
  });
  const verifyCallbackMock = vi.fn(() => {
    if (providerFailure !== undefined) return Promise.reject(providerFailure);
    return Promise.resolve(identity);
  });
  const provider: GoogleOidcProvider = {
    createAuthorizationUrl: createAuthorizationUrlMock,
    verifyCallback: verifyCallbackMock,
  };
  const sessions = {
    create: vi.fn().mockResolvedValue({
      accessToken: "aura.access.token",
      refreshToken: "r".repeat(43),
    }),
    rotate: vi.fn(),
    revoke: vi.fn(),
    isActive: vi.fn().mockResolvedValue(true),
    createDevelopmentSession: vi.fn(),
  };
  const identities = {
    resolveExternalIdentity: vi
      .fn()
      .mockResolvedValue("00000000-0000-4000-8000-000000000099"),
  };
  return {
    provider,
    createAuthorizationUrlMock,
    verifyCallbackMock,
    sessions,
    identities,
    transaction: () => transaction,
  };
}

describe("Google OIDC routes", () => {
  it("starts authorization with state, nonce, PKCE, minimum scopes, and a protected transaction", async () => {
    const h = harness();
    const app = await createApp({
      config: enabledConfig,
      logger: false,
      googleOidcProvider: h.provider,
      externalIdentityResolver: h.identities,
      sessionService: h.sessions,
      tokenVerifier: testTokenVerifier,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start",
    });
    expect(response.statusCode).toBe(302);
    const redirect = new URL(response.headers.location!);
    expect(redirect.origin).toBe("https://accounts.google.com");
    expect(redirect.searchParams.get("scope")).toBe("openid email profile");
    expect(redirect.searchParams.get("client_id")).toBe(
      enabledConfig.googleOidc.clientId,
    );
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      enabledConfig.googleOidc.redirectUri,
    );
    expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
    expect(redirect.searchParams.has("access_token")).toBe(false);
    expect(redirect.href).not.toContain(enabledConfig.googleOidc.clientSecret);
    expect(h.transaction()?.state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(h.transaction()?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(cookieHeaders(response.headers["set-cookie"])).toContain("HttpOnly");
    expect(cookieHeaders(response.headers["set-cookie"])).toContain(
      "SameSite=Lax",
    );
    expect(cookieHeaders(response.headers["set-cookie"])).toContain(
      "Max-Age=600",
    );
    await app.close();
  });

  it("binds a verified identity, creates an AURA session, and redirects without tokens", async () => {
    const h = harness();
    const app = await createApp({
      config: enabledConfig,
      logger: false,
      googleOidcProvider: h.provider,
      externalIdentityResolver: h.identities,
      sessionService: h.sessions,
      tokenVerifier: testTokenVerifier,
    });
    const start = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start",
    });
    const cookie = transactionCookie(start.headers["set-cookie"]);
    const state = h.transaction()!.state;
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=provider-code&state=${state}&returnTo=https://attacker.invalid`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      "http://localhost:3000/?login=success",
    );
    expect(response.headers.location).not.toMatch(/token|code|subject/i);
    expect(h.identities.resolveExternalIdentity).toHaveBeenCalledWith(identity);
    expect(h.sessions.create).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000099",
    );
    expect(cookieHeaders(response.headers["set-cookie"])).toContain(
      "aura_google_oidc=;",
    );
    expect(cookieHeaders(response.headers["set-cookie"])).toContain(
      "aura_refresh=",
    );
    await app.close();
  });

  it.each([
    ["missing state", "?code=provider-code"],
    ["wrong state", "?code=provider-code&state=wrong"],
    ["missing code", "?state=placeholder"],
  ])("rejects %s before identity binding", async (_name, query) => {
    const h = harness();
    const app = await createApp({
      config: enabledConfig,
      logger: false,
      googleOidcProvider: h.provider,
      externalIdentityResolver: h.identities,
      sessionService: h.sessions,
      tokenVerifier: testTokenVerifier,
    });
    const start = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start",
    });
    const adjustedQuery = query.replace("placeholder", h.transaction()!.state);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback${adjustedQuery}`,
      headers: { cookie: transactionCookie(start.headers["set-cookie"]) },
    });
    expect(response.headers.location).toBe(
      "http://localhost:3000/?login=invalid_callback",
    );
    expect(h.verifyCallbackMock).not.toHaveBeenCalled();
    expect(h.sessions.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a missing, expired, or replayed transaction cookie", async () => {
    const h = harness();
    const app = await createApp({
      config: enabledConfig,
      logger: false,
      googleOidcProvider: h.provider,
      externalIdentityResolver: h.identities,
      sessionService: h.sessions,
      tokenVerifier: testTokenVerifier,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/callback?code=code&state=state",
    });
    expect(response.headers.location).toBe(
      "http://localhost:3000/?login=transaction_expired",
    );
    expect(h.verifyCallbackMock).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(["wrong issuer", "wrong audience", "invalid nonce"])(
    "fails safely when provider validation reports %s",
    async (reason) => {
      const h = harness(new Error(reason));
      const app = await createApp({
        config: enabledConfig,
        logger: false,
        googleOidcProvider: h.provider,
        externalIdentityResolver: h.identities,
        sessionService: h.sessions,
        tokenVerifier: testTokenVerifier,
      });
      const start = await app.inject({
        method: "GET",
        url: "/api/v1/auth/google/start",
      });
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/auth/google/callback?code=code&state=${h.transaction()!.state}`,
        headers: { cookie: transactionCookie(start.headers["set-cookie"]) },
      });
      expect(response.headers.location).toBe(
        "http://localhost:3000/?login=login_failed",
      );
      expect(response.payload).not.toContain(reason);
      expect(h.sessions.create).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("maps provider cancellation to a non-sensitive fixed redirect", async () => {
    const h = harness();
    const app = await createApp({
      config: enabledConfig,
      logger: false,
      googleOidcProvider: h.provider,
      externalIdentityResolver: h.identities,
      sessionService: h.sessions,
      tokenVerifier: testTokenVerifier,
    });
    const start = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start",
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?error=access_denied&state=${h.transaction()!.state}`,
      headers: { cookie: transactionCookie(start.headers["set-cookie"]) },
    });
    expect(response.headers.location).toBe(
      "http://localhost:3000/?login=cancelled",
    );
    expect(cookieHeaders(response.headers["set-cookie"])).toContain(
      "Max-Age=0",
    );
    await app.close();
  });

  it("does not expose routes when Google OIDC is disabled", async () => {
    const app = await createApp({
      config: testConfig,
      logger: false,
      tokenVerifier: testTokenVerifier,
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/auth/google/start" }))
        .statusCode,
    ).toBe(404);
    await app.close();
  });
});

function transactionCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  const cookie = value?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("transaction cookie missing");
  return cookie;
}

function cookieHeaders(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join("\n") : (value ?? "");
}
