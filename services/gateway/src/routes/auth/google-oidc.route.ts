import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { GatewayConfig } from "../../config/index.js";
import {
  createOidcTransaction,
  type GoogleOidcProvider,
} from "../../identity/google-oidc-client.js";
import { OidcTransactionCodec } from "../../identity/oidc-transaction.js";
import type { AuthenticatedExternalIdentity } from "../../identity/repositories.js";
import type { SessionManager } from "../../identity/session-service.js";
import { appendCookie, readCookie, setRefreshCookie } from "./cookies.js";

const TRANSACTION_COOKIE = "aura_google_oidc";
const CALLBACK_PATH = "/api/v1/auth/google/callback";

export interface ExternalIdentityResolver {
  resolveExternalIdentity(
    identity: AuthenticatedExternalIdentity,
  ): Promise<string>;
}

export function registerGoogleOidcRoutes(
  app: FastifyInstance,
  config: GatewayConfig,
  provider: GoogleOidcProvider | undefined,
  identities: ExternalIdentityResolver,
  sessions: SessionManager,
): void {
  if (!config.googleOidc.enabled || provider === undefined) return;
  const oidc = config.googleOidc;
  const transactions = new OidcTransactionCodec(
    config.auth.secret,
    oidc.transactionTtlSeconds,
  );

  app.get("/api/v1/auth/google/start", async (_request, reply) => {
    const transaction = createOidcTransaction();
    reply.header("cache-control", "no-store");
    try {
      const authorizationUrl =
        await provider.createAuthorizationUrl(transaction);
      setTransactionCookie(
        reply,
        transactions.encode(transaction),
        config,
        oidc.transactionTtlSeconds,
      );
      return reply.redirect(authorizationUrl.href);
    } catch {
      clearTransactionCookie(reply, config);
      return redirectResult(reply, config, "provider_unavailable");
    }
  });

  app.get(CALLBACK_PATH, async (request, reply) => {
    clearTransactionCookie(reply, config);
    reply.header("cache-control", "no-store");
    const callbackUrl = callbackUrlFromRequest(request.url, oidc.redirectUri);
    const state = singleParameter(callbackUrl, "state");
    const encoded = readCookie(request.headers.cookie, TRANSACTION_COOKIE);
    const transaction =
      encoded === undefined ? undefined : transactions.decode(encoded);
    if (transaction === undefined)
      return redirectResult(reply, config, "transaction_expired");
    if (state === undefined || !safeEqual(state, transaction.state))
      return redirectResult(reply, config, "invalid_callback");
    const error = singleParameter(callbackUrl, "error");
    if (error !== undefined)
      return redirectResult(
        reply,
        config,
        error === "access_denied" ? "cancelled" : "provider_unavailable",
      );
    const code = singleParameter(callbackUrl, "code");
    if (code === undefined)
      return redirectResult(reply, config, "invalid_callback");
    try {
      const identity = await provider.verifyCallback(callbackUrl, transaction);
      const userId = await identities.resolveExternalIdentity(identity);
      const auraSession = await sessions.create(userId);
      setRefreshCookie(reply, auraSession.refreshToken, config);
      return redirectResult(reply, config, "success");
    } catch {
      return redirectResult(reply, config, "login_failed");
    }
  });
}

function callbackUrlFromRequest(requestUrl: string, redirectUri: string): URL {
  const configured = new URL(redirectUri);
  const received = new URL(requestUrl, configured.origin);
  configured.search = received.search;
  return configured;
}

function singleParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0] !== "" ? values[0] : undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function redirectResult(
  reply: FastifyReply,
  config: GatewayConfig,
  result:
    | "success"
    | "cancelled"
    | "provider_unavailable"
    | "transaction_expired"
    | "invalid_callback"
    | "login_failed",
) {
  const destination = new URL(config.browser.origin);
  destination.pathname = "/";
  destination.search = `login=${result}`;
  destination.hash = "";
  return reply.redirect(destination.href);
}

function setTransactionCookie(
  reply: FastifyReply,
  value: string,
  config: GatewayConfig,
  maxAge: number,
): void {
  appendCookie(
    reply,
    `${TRANSACTION_COOKIE}=${value}; Path=${CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.browser.secureCookies ? "; Secure" : ""}`,
  );
}

function clearTransactionCookie(
  reply: FastifyReply,
  config: GatewayConfig,
): void {
  appendCookie(
    reply,
    `${TRANSACTION_COOKIE}=; Path=${CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=0${config.browser.secureCookies ? "; Secure" : ""}`,
  );
}
