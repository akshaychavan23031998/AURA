import { jwtVerify } from "jose";
import { z } from "zod";

import type { GatewayConfig } from "../config/index.js";
import type { SessionManager } from "../identity/session-service.js";
import {
  allowedPermissions,
  type AuthenticatedPrincipal,
} from "./principal.js";

const claimsSchema = z
  .object({
    sub: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    sid: z.uuid(),
    iss: z.string(),
    aud: z.string(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    nbf: z.number().int().nonnegative().optional(),
    permissions: z
      .array(z.enum(allowedPermissions))
      .max(allowedPermissions.length)
      .refine(
        (permissions) => new Set(permissions).size === permissions.length,
      ),
    tokenVersion: z.literal(1),
  })
  .strict();

export interface AccessTokenVerifier {
  verify(token: string): Promise<AuthenticatedPrincipal>;
}

export function createAccessTokenVerifier(
  config: GatewayConfig,
  sessions?: Pick<SessionManager, "isActive">,
): AccessTokenVerifier {
  const secret = new TextEncoder().encode(config.auth.secret);
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, secret, {
        algorithms: ["HS256"],
        issuer: config.auth.issuer,
        audience: config.auth.audience,
        clockTolerance: 2,
        requiredClaims: ["sub", "iat", "exp", "iss", "aud"],
      });
      const claims = claimsSchema.parse(payload);
      const now = Math.floor(Date.now() / 1000);
      if (claims.iat > now + 2 || claims.exp <= claims.iat) {
        throw new Error("Invalid token lifetime");
      }
      if (sessions && !(await sessions.isActive(claims.sid, claims.sub))) {
        throw new Error("Inactive session");
      }
      return Object.freeze({
        actorId: claims.sub,
        sessionId: claims.sid,
        permissions: Object.freeze([...claims.permissions]),
        tokenIssuedAt: claims.iat,
        tokenExpiresAt: claims.exp,
      });
    },
  };
}
