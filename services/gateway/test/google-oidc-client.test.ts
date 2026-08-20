import { describe, expect, it } from "vitest";
import { Configuration } from "openid-client";
import {
  OpenIdClientGoogleProvider,
  createOidcTransaction,
} from "../src/identity/google-oidc-client.js";

const providerConfig = {
  enabled: true as const,
  clientId: "client.apps.googleusercontent.com",
  clientSecret: "client-secret",
  redirectUri: "http://localhost:4000/api/v1/auth/google/callback",
  transactionTtlSeconds: 600 as const,
};

describe("OpenID-certified Google adapter", () => {
  it("builds authorization code plus PKCE with only identity scopes", async () => {
    const configuration = new Configuration(
      {
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
      },
      providerConfig.clientId,
      providerConfig.clientSecret,
    );
    const transaction = createOidcTransaction();
    const url = await new OpenIdClientGoogleProvider(
      providerConfig,
      configuration,
    ).createAuthorizationUrl(transaction);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe(transaction.state);
    expect(url.searchParams.get("nonce")).toBe(transaction.nonce);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      providerConfig.redirectUri,
    );
    expect(url.searchParams.has("access_type")).toBe(false);
    expect(url.searchParams.toString()).not.toMatch(/gmail|calendar|drive/i);
  });
  it("requests only the deliberate Calendar read and event-write scopes when enabled", async () => {
    const configuration = new Configuration(
      {
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
      },
      providerConfig.clientId,
      providerConfig.clientSecret,
    );
    const url = await new OpenIdClientGoogleProvider(
      providerConfig,
      configuration,
      true,
    ).createAuthorizationUrl(createOidcTransaction());
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ]);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.toString()).not.toMatch(
      /gmail|drive|calendar\.acl/i,
    );
  });
  it("adds only Gmail read and narrow send scopes when Gmail is enabled", async () => {
    const configuration = new Configuration(
      {
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
      },
      providerConfig.clientId,
      providerConfig.clientSecret,
    );
    const url = await new OpenIdClientGoogleProvider(
      providerConfig,
      configuration,
      false,
      true,
    ).createAuthorizationUrl(createOidcTransaction());
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ]);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.toString()).not.toMatch(
      /gmail\.modify|mail\.google|drive|calendar/i,
    );
  });
  it("adds only Contacts read scope when Contacts is enabled", async () => {
    const configuration = new Configuration(
      {
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
      },
      providerConfig.clientId,
      providerConfig.clientSecret,
    );
    const url = await new OpenIdClientGoogleProvider(
      providerConfig,
      configuration,
      false,
      false,
      true,
    ).createAuthorizationUrl(createOidcTransaction());
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/contacts.readonly",
    ]);
    expect(url.searchParams.get("access_type")).toBe("offline");
  });
  it("requests exactly the complete enabled V1 Google scope matrix", async () => {
    const configuration = new Configuration(
      {
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
      },
      providerConfig.clientId,
      providerConfig.clientSecret,
    );
    const url = await new OpenIdClientGoogleProvider(
      providerConfig,
      configuration,
      true,
      true,
      true,
    ).createAuthorizationUrl(createOidcTransaction());
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/contacts.readonly",
    ]);
    expect(url.searchParams.get("scope")).not.toMatch(
      /drive|tasks|docs|spreadsheets|admin|mail\.google/i,
    );
  });
});
