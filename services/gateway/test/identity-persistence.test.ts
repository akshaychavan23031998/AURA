import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAccessTokenVerifier } from "../src/auth/token-verifier.js";
import { createDatabaseClient, type DatabaseClient } from "../src/db/client.js";
import { refreshTokens, users } from "../src/db/schema.js";
import { IdentityRepository } from "../src/identity/repositories.js";
import {
  InvalidSessionError,
  SessionService,
} from "../src/identity/session-service.js";
import { digestRefreshToken } from "../src/identity/token.js";
import { testConfig } from "./test-config.js";

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
  database: { url: databaseUrl },
});
const repository = new IdentityRepository(database);
const sessions = new SessionService(repository, testConfig.auth);

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
});
