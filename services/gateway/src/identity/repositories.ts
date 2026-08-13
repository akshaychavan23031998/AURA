import { and, eq, gt, isNull, sql } from "drizzle-orm";

import type { DatabaseClient } from "../db/client.js";
import { refreshTokens, sessions, users } from "../db/schema.js";

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
