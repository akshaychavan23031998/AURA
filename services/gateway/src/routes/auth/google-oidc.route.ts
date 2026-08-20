import { timingSafeEqual } from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  preHandlerHookHandler,
} from "fastify";

import type { GatewayConfig } from "../../config/index.js";
import {
  createOidcTransaction,
  type GoogleOidcProvider,
} from "../../identity/google-oidc-client.js";
import { OidcTransactionCodec } from "../../identity/oidc-transaction.js";
import type { AuthenticatedExternalIdentity } from "../../identity/repositories.js";
import type { SessionManager } from "../../identity/session-service.js";
import { appendCookie, readCookie, setRefreshCookie } from "./cookies.js";
import type { GoogleCredentialStore } from "../../identity/provider-credentials.js";
import {
  GOOGLE_CALENDAR_READ_SCOPE,
  GOOGLE_CALENDAR_WRITE_SCOPE,
  GOOGLE_CONTACTS_READ_SCOPE,
  GOOGLE_GMAIL_READ_SCOPE,
  GOOGLE_GMAIL_SEND_SCOPE,
} from "../../identity/provider-credentials.js";
import { requirePrincipal } from "../../auth/auth-plugin.js";
import { requireBrowserOrigin } from "./auth.route.js";

const TRANSACTION_COOKIE = "aura_google_oidc";
const CALLBACK_PATH = "/api/v1/auth/google/callback";

export interface ExternalIdentityResolver {
  resolveExternalIdentity(
    identity: AuthenticatedExternalIdentity,
  ): Promise<string>;
  findGoogleSubjectForUser?(userId: string): Promise<string | undefined>;
}

export function registerGoogleOidcRoutes(
  app: FastifyInstance,
  config: GatewayConfig,
  provider: GoogleOidcProvider | undefined,
  identities: ExternalIdentityResolver,
  sessions: SessionManager,
  authenticate: preHandlerHookHandler,
  providerCredentials?: GoogleCredentialStore,
): void {
  app.get(
    "/api/v1/integrations/google",
    { preHandler: authenticate },
    async (request) => {
      const principal = requirePrincipal(request);
      const credential = await providerCredentials?.getGoogle(
        principal.actorId,
      );
      return googleIntegrationStatus(config, credential?.scopes);
    },
  );
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

  app.post(
    "/api/v1/integrations/google/reconnect",
    { preHandler: authenticate },
    async (request, reply) => {
      requireBrowserOrigin(request, config);
      if (providerCredentials === undefined)
        return reply.status(409).send({
          error: {
            code: "GOOGLE_CONNECTION_UNAVAILABLE",
            message: "Google connection is unavailable",
            requestId: request.id,
          },
        });
      const principal = requirePrincipal(request);
      const credential = await providerCredentials.getGoogle(principal.actorId);
      const linkedSubject =
        credential?.subject ??
        (await identities.findGoogleSubjectForUser?.(principal.actorId));
      if (linkedSubject === undefined)
        return reply.status(409).send({
          error: {
            code: "GOOGLE_CONNECTION_UNAVAILABLE",
            message: "Google connection is unavailable",
            requestId: request.id,
          },
        });
      const transaction = createOidcTransaction({
        purpose: "reconnect",
        actorId: principal.actorId,
      });
      const authorizationUrl =
        await provider.createAuthorizationUrl(transaction);
      setTransactionCookie(
        reply,
        transactions.encode(transaction),
        config,
        oidc.transactionTtlSeconds,
      );
      reply.header("cache-control", "no-store");
      return { authorizationUrl: authorizationUrl.href };
    },
  );

  app.post(
    "/api/v1/integrations/google/disconnect",
    { preHandler: authenticate },
    async (request, reply) => {
      requireBrowserOrigin(request, config);
      const principal = requirePrincipal(request);
      await providerCredentials?.disconnectGoogle(principal.actorId);
      return reply.status(204).send();
    },
  );

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
      return transaction.purpose === "reconnect"
        ? redirectIntegrationResult(
            reply,
            config,
            error === "access_denied" ? "cancelled" : "failed",
          )
        : redirectResult(
            reply,
            config,
            error === "access_denied" ? "cancelled" : "provider_unavailable",
          );
    const code = singleParameter(callbackUrl, "code");
    if (code === undefined)
      return redirectResult(reply, config, "invalid_callback");
    try {
      const verified = await provider.verifyCallback(callbackUrl, transaction);
      const identity = "identity" in verified ? verified.identity : verified;
      if (transaction.purpose === "reconnect") {
        if (
          transaction.actorId === undefined ||
          providerCredentials === undefined
        )
          throw new Error("Invalid reconnect transaction");
        const existing = await providerCredentials.getGoogle(
          transaction.actorId,
        );
        const linkedSubject =
          existing?.subject ??
          (await identities.findGoogleSubjectForUser?.(transaction.actorId));
        if (
          linkedSubject === undefined ||
          !safeEqual(linkedSubject, identity.subject)
        )
          return redirectIntegrationResult(reply, config, "account_mismatch");
        if (!("identity" in verified))
          throw new Error("Provider credential response unavailable");
        await providerCredentials.storeGoogle(
          transaction.actorId,
          identity.subject,
          verified.refreshToken,
          verified.grantedScopes,
        );
        return redirectIntegrationResult(reply, config, "success");
      }
      const userId = await identities.resolveExternalIdentity(identity);
      if ("identity" in verified) {
        if (providerCredentials === undefined)
          throw new Error("Provider credential storage unavailable");
        await providerCredentials.storeGoogle(
          userId,
          identity.subject,
          verified.refreshToken,
          verified.grantedScopes,
        );
      }
      const auraSession = await sessions.create(userId);
      setRefreshCookie(reply, auraSession.refreshToken, config);
      return redirectResult(reply, config, "success");
    } catch {
      return transaction.purpose === "reconnect"
        ? redirectIntegrationResult(reply, config, "failed")
        : redirectResult(reply, config, "login_failed");
    }
  });
}

type CapabilityId =
  | "calendar.read"
  | "calendar.write"
  | "gmail.read"
  | "gmail.send"
  | "contacts.read";

function googleIntegrationStatus(
  config: GatewayConfig,
  grantedScopes: readonly string[] | undefined,
) {
  const capabilities: Array<{
    id: CapabilityId;
    status: "granted" | "reauth_required";
  }> = [];
  const add = (id: CapabilityId, scope: string) =>
    capabilities.push({
      id,
      status: grantedScopes?.includes(scope) ? "granted" : "reauth_required",
    });
  if (config.googleCalendar.enabled) {
    add("calendar.read", GOOGLE_CALENDAR_READ_SCOPE);
    add("calendar.write", GOOGLE_CALENDAR_WRITE_SCOPE);
  }
  if (config.googleGmail.enabled) {
    add("gmail.read", GOOGLE_GMAIL_READ_SCOPE);
    add("gmail.send", GOOGLE_GMAIL_SEND_SCOPE);
  }
  if (config.googleContacts.enabled)
    add("contacts.read", GOOGLE_CONTACTS_READ_SCOPE);
  return {
    provider: "google" as const,
    linked: grantedScopes !== undefined,
    capabilities,
  };
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

function redirectIntegrationResult(
  reply: FastifyReply,
  config: GatewayConfig,
  result: "success" | "account_mismatch" | "cancelled" | "failed",
) {
  const destination = new URL(config.browser.origin);
  destination.pathname = "/";
  destination.search = `integration=${result}`;
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
