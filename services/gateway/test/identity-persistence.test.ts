import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAccessTokenVerifier } from "../src/auth/token-verifier.js";
import { createDatabaseClient, type DatabaseClient } from "../src/db/client.js";
import {
  externalIdentities,
  providerCredentials,
  refreshTokens,
  toolApprovals,
  userMemories,
  users,
} from "../src/db/schema.js";
import { ApprovalRepository } from "../src/approvals/approval-repository.js";
import { IdentityRepository } from "../src/identity/repositories.js";
import {
  InvalidSessionError,
  SessionService,
} from "../src/identity/session-service.js";
import { digestRefreshToken } from "../src/identity/token.js";
import {
  GOOGLE_CALENDAR_READ_SCOPE,
  ProviderCredentialRepository,
} from "../src/identity/provider-credentials.js";
import { testConfig } from "./test-config.js";
import { MemoryRepository } from "../src/memory/memory-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required for Gateway identity integration tests. Start the isolated PostgreSQL service and point it to a database whose name ends in _test.",
  );
}
const parsedDatabaseUrl = new URL(databaseUrl);
if (!/_(?:test|tests)$/.test(parsedDatabaseUrl.pathname.slice(1))) {
  throw new Error(
    "TEST_DATABASE_URL database name must end in _test or _tests to protect development data",
  );
}

const database: DatabaseClient = createDatabaseClient({
  ...testConfig,
  database: { ...testConfig.database, url: databaseUrl },
});
const repository = new IdentityRepository(database);
const sessions = new SessionService(repository, testConfig.auth);
const approvals = new ApprovalRepository(database);
const memories = new MemoryRepository(database);

beforeAll(async () => {
  await database.db.execute(sql`drop schema if exists public cascade`);
  await database.db.execute(sql`drop schema if exists drizzle cascade`);
  await database.db.execute(sql`create schema public`);
  await migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  return async () => database.close();
});

beforeEach(async () => {
  await database.db.execute(sql`truncate table users cascade`);
});

describe.sequential("PostgreSQL identity persistence", () => {
  it("applies migrations and bootstraps one stable development user", async () => {
    const first = await repository.bootstrapDevelopmentUser();
    const second = await repository.bootstrapDevelopmentUser();
    expect(second).toBe(first);
    await expect(repository.findActiveUser(first)).resolves.toMatchObject({
      id: first,
      status: "ACTIVE",
    });
  });

  it("persists only the refresh digest and validates the created session", async () => {
    const userId = await repository.bootstrapDevelopmentUser();
    const created = await sessions.create(userId);
    const principal = await createAccessTokenVerifier(
      testConfig,
      sessions,
    ).verify(created.accessToken);
    expect(principal.actorId).toBe(userId);
    expect(principal.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const stored = await database.db.select().from(refreshTokens);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(digestRefreshToken(created.refreshToken));
    expect(stored[0]?.tokenHash).not.toBe(created.refreshToken);
  });

  it("rotates tokens, rejects reuse, and revokes the entire session family", async () => {
    const userId = await repository.bootstrapDevelopmentUser();
    const first = await sessions.create(userId);
    const second = await sessions.rotate(first.refreshToken);
    await expect(sessions.rotate(first.refreshToken)).rejects.toBeInstanceOf(
      InvalidSessionError,
    );
    await expect(sessions.rotate(second.refreshToken)).rejects.toBeInstanceOf(
      InvalidSessionError,
    );
  });

  it("allows only one of two concurrent rotations to succeed", async () => {
    const userId = await repository.bootstrapDevelopmentUser();
    const created = await sessions.create(userId);
    const outcomes = await Promise.allSettled([
      sessions.rotate(created.refreshToken),
      sessions.rotate(created.refreshToken),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it("rejects revoked and expired sessions", async () => {
    const userId = await repository.bootstrapDevelopmentUser();
    const revoked = await sessions.create(userId);
    const revokedPrincipal = await createAccessTokenVerifier(
      testConfig,
      sessions,
    ).verify(revoked.accessToken);
    await sessions.revoke(revokedPrincipal.sessionId, userId);
    await expect(sessions.rotate(revoked.refreshToken)).rejects.toBeInstanceOf(
      InvalidSessionError,
    );
    await expect(
      createAccessTokenVerifier(testConfig, sessions).verify(
        revoked.accessToken,
      ),
    ).rejects.toBeDefined();

    const expiredToken = "expired-refresh-token";
    await repository.createSession(
      userId,
      digestRefreshToken(expiredToken),
      new Date(Date.now() - 1),
    );
    await expect(sessions.rotate(expiredToken)).rejects.toBeInstanceOf(
      InvalidSessionError,
    );
  });

  it("rejects access, refresh, and future issuance for a disabled user", async () => {
    const userId = await repository.bootstrapDevelopmentUser();
    const created = await sessions.create(userId);
    await database.db
      .update(users)
      .set({ status: "DISABLED" })
      .where(eq(users.id, userId));
    await expect(
      createAccessTokenVerifier(testConfig, sessions).verify(
        created.accessToken,
      ),
    ).rejects.toBeDefined();
    await expect(sessions.rotate(created.refreshToken)).rejects.toBeInstanceOf(
      InvalidSessionError,
    );
    await expect(sessions.create(userId)).rejects.toBeInstanceOf(
      InvalidSessionError,
    );
  });

  it("binds Google subject rather than email and returns the same user", async () => {
    const verified = {
      provider: "google" as const,
      subject: "google-stable-subject",
      email: "verified@example.com",
      emailVerified: true,
    };
    const first = await repository.resolveExternalIdentity(verified);
    const second = await repository.resolveExternalIdentity({
      ...verified,
      email: "changed@example.com",
    });
    expect(second).toBe(first);
    expect(await database.db.select().from(users)).toHaveLength(1);
    expect(await database.db.select().from(externalIdentities)).toEqual([
      expect.objectContaining({
        userId: first,
        provider: "google",
        providerSubject: "google-stable-subject",
        emailAtLinkTime: "verified@example.com",
      }),
    ]);
  });

  it("does not persist an unverified provider email", async () => {
    await repository.resolveExternalIdentity({
      provider: "google",
      subject: "unverified-email-subject",
      email: "untrusted@example.com",
      emailVerified: false,
    });
    const [binding] = await database.db.select().from(externalIdentities);
    expect(binding?.emailAtLinkTime).toBeNull();
  });

  it("encrypts Calendar credentials and isolates them by linked user", async () => {
    const subject = "calendar-google-subject";
    const userId = await repository.resolveExternalIdentity({
      provider: "google",
      subject,
      emailVerified: false,
    });
    const otherUserId = await repository.bootstrapDevelopmentUser();
    const credentials = new ProviderCredentialRepository(
      database,
      Buffer.alloc(32, 7),
    );
    await credentials.storeGoogle(
      userId,
      subject,
      "provider-refresh-token-must-stay-secret",
      [GOOGLE_CALENDAR_READ_SCOPE],
    );
    await expect(credentials.getGoogle(userId)).resolves.toMatchObject({
      subject,
      refreshToken: "provider-refresh-token-must-stay-secret",
      scopes: [GOOGLE_CALENDAR_READ_SCOPE],
    });
    await expect(credentials.getGoogle(otherUserId)).resolves.toBeUndefined();
    const [stored] = await database.db.select().from(providerCredentials);
    expect(stored?.encryptedRefreshToken).not.toContain(
      "provider-refresh-token-must-stay-secret",
    );
    await credentials.storeGoogle(userId, subject, undefined, [
      GOOGLE_CALENDAR_READ_SCOPE,
      "https://www.googleapis.com/auth/contacts.readonly",
    ]);
    await expect(credentials.getGoogle(userId)).resolves.toMatchObject({
      refreshToken: "provider-refresh-token-must-stay-secret",
      scopes: [
        GOOGLE_CALENDAR_READ_SCOPE,
        "https://www.googleapis.com/auth/contacts.readonly",
      ],
    });
    await credentials.disconnectGoogle(userId);
    await expect(credentials.getGoogle(userId)).resolves.toBeUndefined();
  });

  it("resolves concurrent first login and rolls back the losing partial user", async () => {
    const identity = {
      provider: "google" as const,
      subject: "concurrent-google-subject",
      emailVerified: false,
    };
    const [first, second] = await Promise.all([
      repository.resolveExternalIdentity(identity),
      repository.resolveExternalIdentity(identity),
    ]);
    expect(second).toBe(first);
    expect(await database.db.select().from(users)).toHaveLength(1);
    expect(await database.db.select().from(externalIdentities)).toHaveLength(1);
  });

  it("persists, owns, rejects, expires, and consumes approvals once", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const otherActor = await database.db
      .insert(users)
      .values({})
      .returning({ id: users.id });
    const create = (expiresAt: Date) =>
      approvals.create({
        actorId,
        toolName: "test.approval-required",
        toolVersion: 1,
        inputDigest: "a".repeat(64),
        input: { value: "safe" },
        request: { message: "safe" },
        title: "Confirm test action",
        preview: "Run test approval-required action",
        expiresAt,
      });
    const persisted = await create(new Date(Date.now() + 60_000));
    expect(
      await new ApprovalRepository(database).findOwned(persisted.id, actorId),
    ).toMatchObject({ id: persisted.id, status: "PENDING" });
    expect(
      await approvals.findOwned(persisted.id, otherActor[0]!.id),
    ).toBeUndefined();
    const [first, second] = await Promise.all([
      approvals.consume(persisted.id, actorId, new Date()),
      approvals.consume(persisted.id, actorId, new Date()),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((first ?? second)?.status).toBe("CONSUMED");

    const rejected = await create(new Date(Date.now() + 60_000));
    expect(
      (await approvals.reject(rejected.id, actorId, new Date()))?.status,
    ).toBe("REJECTED");
    expect(
      await approvals.consume(rejected.id, actorId, new Date()),
    ).toBeUndefined();
    const expired = await create(new Date(Date.now() - 1));
    expect(
      await approvals.consume(expired.id, actorId, new Date()),
    ).toBeUndefined();
    const decisionRace = await create(new Date(Date.now() + 60_000));
    const [approvedRace, rejectedRace] = await Promise.all([
      approvals.consume(decisionRace.id, actorId, new Date()),
      approvals.reject(decisionRace.id, actorId, new Date()),
    ]);
    expect([approvedRace, rejectedRace].filter(Boolean)).toHaveLength(1);
    expect(await database.db.select().from(toolApprovals)).toHaveLength(4);
  });

  it("persists owner-scoped memories and preserves them across repository recreation", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const [otherActor] = await database.db.insert(users).values({}).returning();
    const created = await memories.create(actorId, {
      kind: "preference",
      content: "Prefer concise answers",
    });

    await expect(
      new MemoryRepository(database).getOwned(actorId, created.id),
    ).resolves.toMatchObject({
      actorId,
      source: "user_explicit",
      status: "ACTIVE",
    });
    await expect(
      memories.getOwned(otherActor!.id, created.id),
    ).resolves.toBeUndefined();
    await expect(
      memories.listOwned(otherActor!.id, { limit: 20 }),
    ).resolves.toEqual([]);
    await expect(
      memories.deleteOwned(otherActor!.id, created.id, new Date()),
    ).resolves.toBeUndefined();
  });

  it("soft-deletes memories atomically and excludes terminal records", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const created = await memories.create(actorId, {
      kind: "note",
      content: "A private note",
    });
    const now = new Date();
    await expect(
      memories.deleteOwned(actorId, created.id, now),
    ).resolves.toEqual({
      id: created.id,
    });
    await expect(
      memories.deleteOwned(actorId, created.id, now),
    ).resolves.toBeUndefined();
    await expect(
      memories.getOwned(actorId, created.id),
    ).resolves.toBeUndefined();
    await expect(memories.listOwned(actorId, { limit: 20 })).resolves.toEqual(
      [],
    );
    const [stored] = await database.db.select().from(userMemories);
    expect(stored).toMatchObject({ status: "DELETED", deletedAt: now });
  });

  it("enforces the memory user foreign key", async () => {
    await expect(
      memories.create("00000000-0000-4000-8000-000000000099", {
        kind: "fact",
        content: "Cannot belong to an absent user",
      }),
    ).rejects.toBeDefined();
  });
});
