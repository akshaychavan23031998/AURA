import { describe, expect, it } from "vitest";
import {
  isGoogleLoginEnabled,
  loginResultMessage,
  resolveGoogleLoginUrl,
} from "./google-login";

describe("Google login entry", () => {
  it("uses only the configured Gateway and fixed start path", () => {
    expect(resolveGoogleLoginUrl()).toBe(
      "http://localhost:4000/api/v1/auth/google/start",
    );
  });

  it("is disabled unless explicitly enabled at build time", () => {
    expect(isGoogleLoginEnabled({})).toBe(false);
    expect(
      isGoogleLoginEnabled({ NEXT_PUBLIC_GOOGLE_OIDC_ENABLED: "true" }),
    ).toBe(true);
  });

  it("maps only allowlisted callback results to safe messages", () => {
    expect(loginResultMessage("?login=cancelled")).toMatch(/cancelled/i);
    expect(loginResultMessage("?login=transaction_expired")).toMatch(
      /expired/i,
    );
    expect(
      loginResultMessage("?login=https://attacker.invalid&login=cancelled"),
    ).toBeUndefined();
    expect(loginResultMessage("?login=provider-secret-value")).toBeUndefined();
  });
});
