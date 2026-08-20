import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app/create-app.js";
import type { AccessTokenVerifier } from "../src/auth/token-verifier.js";
import type {
  GoogleOidcProvider,
  OidcTransaction,
} from "../src/identity/google-oidc-client.js";
import type { GoogleCredentialStore } from "../src/identity/provider-credentials.js";
import { testConfig } from "./test-config.js";

const actorId = "00000000-0000-4000-8000-000000000099";
const auth = { authorization: "Bearer test.header.signature" };
const verifier: AccessTokenVerifier = {
  verify: vi.fn().mockResolvedValue({
    actorId,
    sessionId: "00000000-0000-4000-8000-000000000001",
    permissions: [],
    tokenIssuedAt: 1,
    tokenExpiresAt: 2,
  }),
};
const config = {
  ...testConfig,
  googleOidc: {
    enabled: true as const,
    clientId: "client.apps.googleusercontent.com",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:4000/api/v1/auth/google/callback",
    transactionTtlSeconds: 600 as const,
  },
  googleCalendar: {
    enabled: true as const,
    tokenEncryptionKey: Buffer.alloc(32).toString("base64"),
  },
  googleGmail: {
    enabled: true as const,
    tokenEncryptionKey: Buffer.alloc(32).toString("base64"),
  },
  googleContacts: {
    enabled: true as const,
    tokenEncryptionKey: Buffer.alloc(32).toString("base64"),
  },
};

function credentialStore(scopes: readonly string[]): GoogleCredentialStore {
  return {
    getGoogle: vi.fn().mockResolvedValue({
      subject: "google-subject",
      refreshToken: "stored-refresh-token-value",
      scopes,
    }),
    storeGoogle: vi.fn().mockResolvedValue(undefined),
    disconnectGoogle: vi.fn().mockResolvedValue(undefined),
  };
}

function provider(subject = "google-subject") {
  let transaction: OidcTransaction | undefined;
  const value: GoogleOidcProvider = {
    createAuthorizationUrl: vi.fn((input: OidcTransaction) => {
      transaction = input;
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("state", input.state);
      return Promise.resolve(url);
    }),
    verifyCallback: vi.fn().mockResolvedValue({
      identity: {
        provider: "google",
        subject,
        emailVerified: true,
      },
      grantedScopes: [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/contacts.readonly",
      ],
    }),
  };
  return { value, transaction: () => transaction };
}

describe("Google integration management", () => {
  it("requires authentication and derives sanitized partial capability state", async () => {
    const store = credentialStore([
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/contacts.readonly",
    ]);
    const app = await createApp({
      config,
      logger: false,
      tokenVerifier: verifier,
      googleOidcProvider: provider().value,
      providerCredentialRepository: store,
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/integrations/google" }))
        .statusCode,
    ).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/google?actorId=attacker",
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      provider: "google",
      linked: true,
      capabilities: [
        { id: "calendar.read", status: "granted" },
        { id: "calendar.write", status: "reauth_required" },
        { id: "gmail.read", status: "reauth_required" },
        { id: "gmail.send", status: "reauth_required" },
        { id: "contacts.read", status: "granted" },
      ],
    });
    expect(JSON.stringify(response.json())).not.toMatch(/token|subject|scope/i);
    expect(store.getGoogle).toHaveBeenCalledWith(actorId);
    await app.close();
  });

  it("binds re-consent to the authenticated actor and preserves an omitted refresh token", async () => {
    const store = credentialStore([]);
    const oidc = provider();
    const app = await createApp({
      config,
      logger: false,
      tokenVerifier: verifier,
      googleOidcProvider: oidc.value,
      providerCredentialRepository: store,
    });
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/google/reconnect",
      headers: { ...auth, origin: config.browser.origin },
    });
    expect(start.statusCode).toBe(200);
    const reconnectResponse = start.json<{ authorizationUrl: string }>();
    expect(reconnectResponse.authorizationUrl).toMatch(
      /^https:\/\/accounts\.google\.com/,
    );
    expect(oidc.transaction()).toMatchObject({ purpose: "reconnect", actorId });
    const cookie = String(start.headers["set-cookie"]).split(";", 1)[0];
    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=code&state=${oidc.transaction()!.state}`,
      headers: { cookie },
    });
    expect(callback.headers.location).toBe(
      "http://localhost:3000/?integration=success",
    );
    expect(store.storeGoogle).toHaveBeenCalledWith(
      actorId,
      "google-subject",
      undefined,
      expect.any(Array),
    );
    await app.close();
  });

  it("rejects a different Google subject without replacing credentials", async () => {
    const store = credentialStore([]);
    const oidc = provider("different-subject");
    const app = await createApp({
      config,
      logger: false,
      tokenVerifier: verifier,
      googleOidcProvider: oidc.value,
      providerCredentialRepository: store,
    });
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/google/reconnect",
      headers: { ...auth, origin: config.browser.origin },
    });
    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=code&state=${oidc.transaction()!.state}`,
      headers: { cookie: String(start.headers["set-cookie"]).split(";", 1)[0] },
    });
    expect(callback.headers.location).toBe(
      "http://localhost:3000/?integration=account_mismatch",
    );
    expect(store.storeGoogle).not.toHaveBeenCalled();
    await app.close();
  });

  it("disconnects only the authenticated user's credential without ending the AURA session", async () => {
    const store = credentialStore([]);
    const app = await createApp({
      config,
      logger: false,
      tokenVerifier: verifier,
      googleOidcProvider: provider().value,
      providerCredentialRepository: store,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/google/disconnect",
      headers: { ...auth, origin: config.browser.origin },
      payload: { actorId: "attacker" },
    });
    expect(response.statusCode).toBe(204);
    expect(store.disconnectGoogle).toHaveBeenCalledWith(actorId);
    await app.close();
  });
});
