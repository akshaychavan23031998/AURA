import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import { z } from "zod";

import { requirePrincipal } from "../../auth/auth-plugin.js";
import type { GatewayConfig } from "../../config/index.js";
import { AppError } from "../../errors/app-error.js";
import {
  InvalidSessionError,
  type SessionManager,
} from "../../identity/session-service.js";

const REFRESH_COOKIE = "aura_refresh";
const COOKIE_PATH = "/api/v1/auth";
const refreshSchema = z
  .object({ refreshToken: z.string().min(40).max(256) })
  .strict();

export function registerAuthRoutes(
  app: FastifyInstance,
  sessions: SessionManager,
  authenticate: preHandlerHookHandler,
  config: GatewayConfig,
): void {
  app.post("/api/v1/auth/refresh", async (request, reply) => {
    const cookieToken = readCookie(request.headers.cookie, REFRESH_COOKIE);
    const body = refreshSchema.safeParse(request.body);
    const refreshToken =
      cookieToken ?? (body.success ? body.data.refreshToken : undefined);
    if (refreshToken === undefined) throw unauthenticated();
    if (cookieToken !== undefined) requireBrowserOrigin(request, config);
    try {
      const tokens = await sessions.rotate(refreshToken);
      if (cookieToken === undefined) return tokens;
      setRefreshCookie(reply, tokens.refreshToken, config);
      return { accessToken: tokens.accessToken };
    } catch (error) {
      if (cookieToken !== undefined) clearRefreshCookie(reply, config);
      if (error instanceof InvalidSessionError) throw unauthenticated();
      throw error;
    }
  });

  app.post(
    "/api/v1/auth/logout",
    { preHandler: authenticate },
    async (request, reply) => {
      if (readCookie(request.headers.cookie, REFRESH_COOKIE) !== undefined)
        requireBrowserOrigin(request, config);
      const principal = requirePrincipal(request);
      await sessions.revoke(principal.sessionId, principal.actorId);
      clearRefreshCookie(reply, config);
      return reply.status(204).send();
    },
  );

  app.post("/api/v1/auth/development-session", async (request, reply) => {
    if (!config.browser.developmentSessionEnabled) throw routeNotFound();
    requireBrowserOrigin(request, config);
    const tokens = await sessions.createDevelopmentSession();
    setRefreshCookie(reply, tokens.refreshToken, config);
    return { accessToken: tokens.accessToken };
  });
}

function requireBrowserOrigin(
  request: FastifyRequest,
  config: GatewayConfig,
): void {
  if (request.headers.origin !== config.browser.origin)
    throw new AppError({
      code: "INVALID_ORIGIN",
      httpStatus: 403,
      message: "Request origin is not allowed",
    });
}

function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (header === undefined || header.length > 8_192) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{40,256}$/.test(value) ? value : undefined;
  }
  return undefined;
}

function setRefreshCookie(
  reply: FastifyReply,
  token: string,
  config: GatewayConfig,
): void {
  reply.header(
    "set-cookie",
    `${REFRESH_COOKIE}=${token}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${config.auth.sessionTtlSeconds}${config.browser.secureCookies ? "; Secure" : ""}`,
  );
  reply.header("cache-control", "no-store");
}

function clearRefreshCookie(reply: FastifyReply, config: GatewayConfig): void {
  reply.header(
    "set-cookie",
    `${REFRESH_COOKIE}=; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0${config.browser.secureCookies ? "; Secure" : ""}`,
  );
  reply.header("cache-control", "no-store");
}

function unauthenticated(): AppError {
  return new AppError({
    code: "UNAUTHENTICATED",
    httpStatus: 401,
    message: "Authentication required",
  });
}

function routeNotFound(): AppError {
  return new AppError({
    code: "ROUTE_NOT_FOUND",
    httpStatus: 404,
    message: "Route not found",
  });
}
