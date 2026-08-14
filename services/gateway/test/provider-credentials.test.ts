import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_CALENDAR_READ_SCOPE,
  GOOGLE_CALENDAR_WRITE_SCOPE,
  GOOGLE_GMAIL_READ_SCOPE,
  GoogleProviderAccessTokenService,
} from "../src/identity/provider-credentials.js";

describe("GoogleProviderAccessTokenService", () => {
  it("refreshes with the fixed token endpoint without exposing the credential", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ access_token: "fresh-access-token-value" }),
      );
    const service = new GoogleProviderAccessTokenService(
      {
        getGoogle: vi.fn().mockResolvedValue({
          subject: "google-subject",
          refreshToken: "stored-refresh-token-value",
          scopes: [GOOGLE_CALENDAR_READ_SCOPE],
        }),
      },
      "client-id",
      "client-secret",
      fetcher,
    );
    await expect(service.getAccessToken("actor-1")).resolves.toBe(
      "fresh-access-token-value",
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://oauth2.googleapis.com/token",
    );
  });

  it("fails closed when credentials, scope, or refresh are unavailable", async () => {
    const missing = new GoogleProviderAccessTokenService(
      { getGoogle: vi.fn().mockResolvedValue(undefined) },
      "client-id",
      "client-secret",
    );
    await expect(missing.getAccessToken("actor-1")).rejects.toMatchObject({
      code: "PROVIDER_REAUTH_REQUIRED",
    });
    const revoked = new GoogleProviderAccessTokenService(
      {
        getGoogle: vi.fn().mockResolvedValue({
          subject: "subject",
          refreshToken: "revoked-refresh-token-value",
          scopes: [GOOGLE_CALENDAR_READ_SCOPE],
        }),
      },
      "client-id",
      "client-secret",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("sensitive provider body", { status: 400 }),
        ),
    );
    await expect(revoked.getAccessToken("actor-1")).rejects.toMatchObject({
      code: "PROVIDER_REAUTH_REQUIRED",
      message: "Google Calendar connection is required",
    });
    await expect(
      revoked.getAccessToken("actor-1", GOOGLE_CALENDAR_WRITE_SCOPE),
    ).rejects.toMatchObject({ code: "PROVIDER_REAUTH_REQUIRED" });
    await expect(
      revoked.getAccessToken("actor-1", GOOGLE_GMAIL_READ_SCOPE),
    ).rejects.toMatchObject({ code: "PROVIDER_REAUTH_REQUIRED" });
  });
});
