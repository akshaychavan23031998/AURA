import { and, eq, gt, isNull, sql } from "drizzle-orm";

import type { DatabaseClient } from "../db/client.js";
import {
  externalIdentities,
  refreshTokens,
  sessions,
  users,
} from "../db/schema.js";

export interface AuthenticatedExternalIdentity {
  readonly provider: "google";
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly displayName?: string;
}

export class IdentityRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async bootstrapDevelopmentUser(): Promise<string> {
    const [user] = await this.database.db
      .insert(users)
      .values({ developmentKey: "default" })
      .onConflictDoUpdate({
        target: users.developmentKey,
        set: { updatedAt: new Date() },
      })
      .returning({ id: users.id });
    if (!user) throw new Error("Unable to bootstrap development user");
    return user.id;
  }

  public async findActiveUser(userId: string) {
    const [user] = await this.database.db
      .select()
      .from(users)
      .where(and(eq(users.id, userId), eq(users.status, "ACTIVE")))
      .limit(1);
    return user;
  }

  public async resolveExternalIdentity(
    identity: AuthenticatedExternalIdentity,
  ): Promise<string> {
    const existing = await this.findExternalIdentity(
      identity.provider,
      identity.subject,
    );
    if (existing !== undefined) return existing;
    try {
      return await this.database.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({})
          .returning({ id: users.id });
        if (!user) throw new Error("Unable to create external user");
        const [binding] = await tx
          .insert(externalIdentities)
          .values({
            userId: user.id,
            provider: identity.provider,
            providerSubject: identity.subject,
            emailAtLinkTime:
              identity.emailVerified && identity.email !== undefined
                ? identity.email
                : null,
          })
          .returning({ userId: externalIdentities.userId });
        if (!binding) throw new Error("Unable to bind external identity");
        return binding.userId;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.findExternalIdentity(
        identity.provider,
        identity.subject,
      );
      if (raced === undefined) throw error;
      return raced;
    }
  }

  private async findExternalIdentity(
    provider: "google",
    subject: string,
  ): Promise<string | undefined> {
    const [binding] = await this.database.db
      .select({ userId: externalIdentities.userId })
      .from(externalIdentities)
      .innerJoin(users, eq(users.id, externalIdentities.userId))
      .where(
        and(
          eq(externalIdentities.provider, provider),
          eq(externalIdentities.providerSubject, subject),
          eq(users.status, "ACTIVE"),
        ),
      )
      .limit(1);
    return binding?.userId;
  }

  public async createSession(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ) {
    return this.database.db.transaction(async (tx) => {
      const [session] = await tx
        .insert(sessions)
        .values({ userId, expiresAt })
        .returning();
      if (!session) throw new Error("Unable to create session");
      await tx
        .insert(refreshTokens)
        .values({ sessionId: session.id, tokenHash, expiresAt });
      return session;
    });
  }

  public async isSessionActive(
    sessionId: string,
    userId: string,
    now: Date,
  ): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
          eq(users.status, "ACTIVE"),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  public async revokeSession(
    sessionId: string,
    userId?: string,
  ): Promise<void> {
    const condition =
      userId === undefined
        ? eq(sessions.id, sessionId)
        : and(eq(sessions.id, sessionId), eq(sessions.userId, userId));
    await this.database.db
      .update(sessions)
      .set({
        revokedAt: sql`coalesce(${sessions.revokedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(condition);
    await this.database.db
      .update(refreshTokens)
      .set({ revokedAt: sql`coalesce(${refreshTokens.revokedAt}, now())` })
      .where(eq(refreshTokens.sessionId, sessionId));
  }

  public async rotate(tokenHash: string, replacementHash: string, now: Date) {
    return this.database.db.transaction(async (tx) => {
      const [token] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .for("update")
        .limit(1);
      if (!token) return { kind: "invalid" as const };
      if (token.usedAt || token.revokedAt) {
        await tx
          .update(sessions)
          .set({ revokedAt: now, updatedAt: now })
          .where(eq(sessions.id, token.sessionId));
        await tx
          .update(refreshTokens)
          .set({ revokedAt: now })
          .where(eq(refreshTokens.sessionId, token.sessionId));
        return { kind: "reused" as const };
      }
      const [session] = await tx
        .select()
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.id, token.sessionId))
        .for("update")
        .limit(1);
      if (
        !session ||
        session.sessions.revokedAt ||
        session.sessions.expiresAt <= now ||
        session.users.status !== "ACTIVE" ||
        token.expiresAt <= now
      )
        return { kind: "invalid" as const };
      const [replacement] = await tx
        .insert(refreshTokens)
        .values({
          sessionId: token.sessionId,
          tokenHash: replacementHash,
          expiresAt: session.sessions.expiresAt,
        })
        .returning({ id: refreshTokens.id });
      if (!replacement) throw new Error("Unable to rotate refresh token");
      const updated = await tx
        .update(refreshTokens)
        .set({ usedAt: now, replacedById: replacement.id })
        .where(
          and(eq(refreshTokens.id, token.id), isNull(refreshTokens.usedAt)),
        )
        .returning({ id: refreshTokens.id });
      if (updated.length !== 1)
        throw new Error("Concurrent refresh rotation rejected");
      await tx
        .update(sessions)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(eq(sessions.id, token.sessionId));
      return {
        kind: "rotated" as const,
        sessionId: token.sessionId,
        userId: session.users.id,
      };
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && current.code === "23505") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
