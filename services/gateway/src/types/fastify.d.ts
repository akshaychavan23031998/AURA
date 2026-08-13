import type { AuthenticatedPrincipal } from "../auth/principal.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: AuthenticatedPrincipal | null;
  }
}
