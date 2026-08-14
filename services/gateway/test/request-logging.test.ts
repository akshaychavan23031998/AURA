import { describe, expect, it } from "vitest";
import { sanitizeRequestUrl } from "../src/app/create-app.js";

describe("request logging privacy", () => {
  it("removes OAuth callback query parameters from structured request logs", () => {
    const serialized = sanitizeRequestUrl(
      "/api/v1/auth/google/callback?code=provider-secret-code&state=state",
    );
    expect(serialized).toBe("/api/v1/auth/google/callback");
    expect(serialized).not.toMatch(/provider-secret-code|state=/);
  });
});
