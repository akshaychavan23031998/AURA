import type { AuthConfig } from "../config/index.js";
import { issueAccessToken } from "../auth/token-issuer.js";
import { IdentityRepository } from "./repositories.js";
import { digestRefreshToken, generateRefreshToken } from "./token.js";

export interface SessionManager {
  create(
    userId: string,
  ): Promise<{ accessToken: string; refreshToken: string }>;
  rotate(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string }>;
  revoke(sessionId: string, userId: string): Promise<void>;
  isActive(sessionId: string, userId: string): Promise<boolean>;
}

export class InvalidSessionError extends Error {}

export class SessionService implements SessionManager {
  public constructor(
    private readonly repository: IdentityRepository,
    private readonly auth: AuthConfig,
  ) {}

  public async create(userId: string) {
    if (!(await this.repository.findActiveUser(userId)))
      throw new InvalidSessionError();
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + this.auth.sessionTtlSeconds * 1000);
    const session = await this.repository.createSession(
      userId,
      digestRefreshToken(refreshToken),
      expiresAt,
    );
    return {
      accessToken: await issueAccessToken(this.auth, userId, session.id),
      refreshToken,
    };
  }

  public async rotate(refreshToken: string) {
    const replacement = generateRefreshToken();
    const result = await this.repository.rotate(
      digestRefreshToken(refreshToken),
      digestRefreshToken(replacement),
      new Date(),
    );
    if (result.kind !== "rotated") throw new InvalidSessionError();
    return {
      accessToken: await issueAccessToken(
        this.auth,
        result.userId,
        result.sessionId,
      ),
      refreshToken: replacement,
    };
  }

  public async revoke(sessionId: string, userId: string): Promise<void> {
    await this.repository.revokeSession(sessionId, userId);
  }

  public isActive(sessionId: string, userId: string): Promise<boolean> {
    return this.repository.isSessionActive(sessionId, userId, new Date());
  }
}
