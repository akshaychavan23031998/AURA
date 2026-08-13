import type { AccessTokenVerifier } from "../src/auth/token-verifier.js";

export const testAuthorizationHeader = {
  authorization: "Bearer test.header.signature",
} as const;

export const testTokenVerifier: AccessTokenVerifier = {
  verify: () =>
    Promise.resolve(
      Object.freeze({
        actorId: "local-user-001",
        sessionId: "00000000-0000-4000-8000-000000000001",
        permissions: Object.freeze(["system.echo"] as const),
        tokenIssuedAt: 1_700_000_000,
        tokenExpiresAt: 1_700_000_900,
      }),
    ),
};
