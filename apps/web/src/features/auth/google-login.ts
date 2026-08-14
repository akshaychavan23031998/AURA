import { resolveGatewayHttpUrl } from "../voice/gateway-url";

const RESULT_MESSAGES: Readonly<Record<string, string>> = {
  cancelled: "Google sign-in was cancelled.",
  provider_unavailable: "Google sign-in is temporarily unavailable.",
  transaction_expired: "The sign-in attempt expired. Please try again.",
  invalid_callback: "The sign-in response was invalid. Please try again.",
  login_failed: "AURA could not complete sign-in. Please try again.",
};

export function resolveGoogleLoginUrl(): string {
  return new URL(
    "api/v1/auth/google/start",
    resolveGatewayHttpUrl(),
  ).toString();
}

export function loginResultMessage(search: string): string | undefined {
  const values = new URLSearchParams(search).getAll("login");
  if (values.length !== 1 || values[0] === undefined) return undefined;
  return RESULT_MESSAGES[values[0]];
}

export function isGoogleLoginEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment.NEXT_PUBLIC_GOOGLE_OIDC_ENABLED === "true";
}
