import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import { requirePrincipal } from "../../auth/auth-plugin.js";
import { AppError } from "../../errors/app-error.js";
import {
  InvalidSessionError,
  type SessionManager,
} from "../../identity/session-service.js";

const refreshSchema = z
  .object({ refreshToken: z.string().min(40).max(256) })
  .strict();

export function registerAuthRoutes(
  app: FastifyInstance,
  sessions: SessionManager,
  authenticate: preHandlerHookHandler,
): void {
  app.post("/api/v1/auth/refresh", async (request) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) throw unauthenticated();
    try {
      return await sessions.rotate(parsed.data.refreshToken);
    } catch (error) {
      if (error instanceof InvalidSessionError) throw unauthenticated();
      throw error;
    }
  });

  app.post(
    "/api/v1/auth/logout",
    { preHandler: authenticate },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      await sessions.revoke(principal.sessionId, principal.actorId);
      return reply.status(204).send();
    },
  );
}

function unauthenticated(): AppError {
  return new AppError({
    code: "UNAUTHENTICATED",
    httpStatus: 401,
    message: "Authentication required",
  });
}
