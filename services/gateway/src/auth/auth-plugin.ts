import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

import { AppError } from "../errors/app-error.js";
import type { AuthenticatedPrincipal } from "./principal.js";
import type { AccessTokenVerifier } from "./token-verifier.js";

const MAX_TOKEN_LENGTH = 4096;
const BEARER_TOKEN =
  /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

export function parseBearerAuthorization(
  header: string | string[] | undefined,
): string {
  if (typeof header !== "string" || header.length > MAX_TOKEN_LENGTH + 7) {
    throw unauthenticated();
  }
  const match = BEARER_TOKEN.exec(header);
  const token = match?.[1];
  if (token === undefined || token.length > MAX_TOKEN_LENGTH) {
    throw unauthenticated();
  }
  return token;
}

export function registerAuthentication(
  app: FastifyInstance,
  verifier: AccessTokenVerifier,
): preHandlerHookHandler {
  app.decorateRequest("principal", null);

  return (request, _reply, done) => {
    void authenticateRequest(request, verifier).then(
      () => done(),
      (error: unknown) =>
        done(error instanceof Error ? error : unauthenticated()),
    );
  };
}

async function authenticateRequest(
  request: FastifyRequest,
  verifier: AccessTokenVerifier,
): Promise<void> {
  try {
    const token = parseBearerAuthorization(request.headers.authorization);
    request.principal = await verifier.verify(token);
    request.log.info(
      { authenticated: true, actorId: request.principal.actorId },
      "Request authenticated",
    );
  } catch {
    request.log.warn(
      {
        reasonCategory: "invalid_credentials",
        route: request.routeOptions.url,
      },
      "Request authentication failed",
    );
    throw unauthenticated();
  }
}

export function requirePrincipal(
  request: FastifyRequest,
): AuthenticatedPrincipal {
  if (request.principal === null) throw unauthenticated();
  return request.principal;
}

function unauthenticated(): AppError {
  return new AppError({
    code: "UNAUTHENTICATED",
    httpStatus: 401,
    message: "Authentication required",
  });
}
