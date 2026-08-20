import { describe, expect, it, vi } from "vitest";
import { GoogleIntegrationApi } from "./google-integration";

function http(response: Response) {
  return { request: vi.fn().mockResolvedValue(response) };
}

describe("GoogleIntegrationApi", () => {
  it("accepts only the sanitized capability contract", async () => {
    const client = http(
      Response.json({
        provider: "google",
        linked: true,
        capabilities: [{ id: "contacts.read", status: "granted" }],
      }),
    );
    await expect(
      new GoogleIntegrationApi(client).status(),
    ).resolves.toMatchObject({ linked: true });
  });

  it("rejects an authorization URL outside Google's fixed origin", async () => {
    const client = http(
      Response.json({ authorizationUrl: "https://attacker.invalid/oauth" }),
    );
    await expect(new GoogleIntegrationApi(client).reconnect()).rejects.toThrow(
      "Invalid Google authorization origin",
    );
  });

  it("uses fixed Gateway paths and explicit POST mutations", async () => {
    const client = http(
      Response.json({
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      }),
    );
    const api = new GoogleIntegrationApi(
      client,
      new URL("https://gateway.example.com"),
    );
    await api.reconnect();
    expect(client.request).toHaveBeenCalledWith(
      new URL(
        "https://gateway.example.com/api/v1/integrations/google/reconnect",
      ),
      { method: "POST" },
    );
  });
});
