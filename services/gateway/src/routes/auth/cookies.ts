import type { FastifyReply } from "fastify";
import type { GatewayConfig } from "../../config/index.js";

const REFRESH_COOKIE = "aura_refresh";
const REFRESH_PATH = "/api/v1/auth";

export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (header === undefined || header.length > 8_192) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

export function setRefreshCookie(
  reply: FastifyReply,
  token: string,
  config: GatewayConfig,
): void {
  appendCookie(
    reply,
    `${REFRESH_COOKIE}=${token}; Path=${REFRESH_PATH}; HttpOnly; SameSite=Strict; Max-Age=${config.auth.sessionTtlSeconds}${config.browser.secureCookies ? "; Secure" : ""}`,
  );
  reply.header("cache-control", "no-store");
}

export function clearRefreshCookie(
  reply: FastifyReply,
  config: GatewayConfig,
): void {
  appendCookie(
    reply,
    `${REFRESH_COOKIE}=; Path=${REFRESH_PATH}; HttpOnly; SameSite=Strict; Max-Age=0${config.browser.secureCookies ? "; Secure" : ""}`,
  );
  reply.header("cache-control", "no-store");
}

export function readRefreshCookie(
  header: string | undefined,
): string | undefined {
  const value = readCookie(header, REFRESH_COOKIE);
  return value !== undefined && /^[A-Za-z0-9_-]{40,256}$/.test(value)
    ? value
    : undefined;
}

export function appendCookie(reply: FastifyReply, cookie: string): void {
  const existing = reply.getHeader("set-cookie");
  const cookies = Array.isArray(existing)
    ? [...existing.map(String), cookie]
    : existing === undefined
      ? [cookie]
      : [String(existing), cookie];
  reply.header("set-cookie", cookies);
}
