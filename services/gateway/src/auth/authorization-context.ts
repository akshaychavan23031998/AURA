import type { TrustedToolContext } from "../clients/tools/tool-service-client.js";
import type { AuthenticatedPrincipal } from "./principal.js";

export function deriveAuthorizationContext(
  principal: AuthenticatedPrincipal,
): TrustedToolContext {
  return Object.freeze({
    actorId: principal.actorId,
    grantedPermissions: Object.freeze([...principal.permissions]),
  });
}
