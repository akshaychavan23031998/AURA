import { describe, expect, it, vi } from "vitest";

import type { AuthConfig } from "../src/config/index.js";
import {
  InvalidSessionError,
  SessionService,
} from "../src/identity/session-service.js";
import type { IdentityRepository } from "../src/identity/repositories.js";
import {
  digestRefreshToken,
  generateRefreshToken,
} from "../src/identity/token.js";

const auth: AuthConfig = {
  secret: "gateway-jwt-test-secret-at-least-32-characters",
  issuer: "aura-gateway",
  audience: "aura-api",
  accessTokenTtlSeconds: 900,
  sessionTtlSeconds: 604_800,
};
const userId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";

function repository() {
  return {
    findActiveUser: vi.fn().mockResolvedValue({ id: userId, status: "ACTIVE" }),
    createSession: vi.fn().mockResolvedValue({ id: sessionId, userId }),
    rotate: vi.fn(),
    revokeSession: vi.fn().mockResolvedValue(undefined),
    isSessionActive: vi.fn().mockResolvedValue(true),
  };
}

describe("refresh-token primitives", () => {
  it("generates high-entropy opaque tokens and deterministic SHA-256 digests", () => {
    const first = generateRefreshToken();
    const second = generateRefreshToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(digestRefreshToken(first)).toBe(digestRefreshToken(first));
    expect(digestRefreshToken(first)).not.toBe(first);
  });
});

describe("SessionService", () => {
  it("creates a persisted session and returns sid-bound access and opaque refresh tokens", async () => {
    const repo = repository();
    const result = await new SessionService(
      repo as unknown as IdentityRepository,
      auth,
    ).create(userId);
    expect(result.accessToken.split(".")).toHaveLength(3);
    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repo.createSession).toHaveBeenCalledWith(
      userId,
      digestRefreshToken(result.refreshToken),
      expect.any(Date),
    );
  });

  it("rejects session issuance for a disabled or missing user", async () => {
    const repo = repository();
    repo.findActiveUser.mockResolvedValueOnce(undefined);
    await expect(
      new SessionService(repo as unknown as IdentityRepository, auth).create(
        userId,
      ),
    ).rejects.toBeInstanceOf(InvalidSessionError);
  });

  it("rotates a refresh token and issues a replacement", async () => {
    const repo = repository();
    repo.rotate.mockResolvedValueOnce({ kind: "rotated", userId, sessionId });
    const result = await new SessionService(
      repo as unknown as IdentityRepository,
      auth,
    ).rotate("a".repeat(43));
    expect(result.refreshToken).not.toBe("a".repeat(43));
    expect(repo.rotate).toHaveBeenCalledWith(
      digestRefreshToken("a".repeat(43)),
      digestRefreshToken(result.refreshToken),
      expect.any(Date),
    );
  });

  it.each(["invalid", "reused"] as const)(
    "rejects %s refresh evidence",
    async (kind) => {
      const repo = repository();
      repo.rotate.mockResolvedValueOnce({ kind });
      await expect(
        new SessionService(repo as unknown as IdentityRepository, auth).rotate(
          "a".repeat(43),
        ),
      ).rejects.toBeInstanceOf(InvalidSessionError);
    },
  );

  it("revokes only the principal's session", async () => {
    const repo = repository();
    await new SessionService(
      repo as unknown as IdentityRepository,
      auth,
    ).revoke(sessionId, userId);
    expect(repo.revokeSession).toHaveBeenCalledWith(sessionId, userId);
  });
});
