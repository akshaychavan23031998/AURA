import { SignJWT } from "jose";

import type { AuthConfig } from "../config/index.js";
import type { AllowedPermission } from "./principal.js";

export async function issueAccessToken(
  config: AuthConfig,
  subject: string,
  sessionId: string,
  permissions: readonly AllowedPermission[] = ["system.echo"],
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  return new SignJWT({
    permissions: [...permissions],
    tokenVersion: 1,
    sid: sessionId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(subject)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + config.accessTokenTtlSeconds)
    .sign(new TextEncoder().encode(config.secret));
}
