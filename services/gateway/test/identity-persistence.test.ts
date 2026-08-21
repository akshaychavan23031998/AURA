import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAccessTokenVerifier } from "../src/auth/token-verifier.js";
import { createDatabaseClient, type DatabaseClient } from "../src/db/client.js";
import {
  externalIdentities,
  knowledgeChunkEmbeddings,
  knowledgeChunks,
  knowledgeDocuments,
  providerCredentials,
  refreshTokens,
  toolApprovals,
  userMemories,
  users,
  workflowStepDependencies,
  workflowStepExecutions,
  workflowSteps,
  workflows,
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
import { MemoryEmbeddingRepository } from "../src/memory/memory-embedding-repository.js";
import { KnowledgeRepository } from "../src/knowledge/knowledge-repository.js";
import { KnowledgeEmbeddingRepository } from "../src/knowledge/knowledge-embedding-repository.js";
import { sha256 } from "../src/knowledge/knowledge-service.js";
import { WorkflowRepository } from "../src/workflows/workflow-repository.js";
import { WorkflowService } from "../src/workflows/workflow-service.js";
import { WorkflowExecutor } from "../src/workflows/workflow-executor.js";

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
const memoryEmbeddings = new MemoryEmbeddingRepository(database);
const knowledge = new KnowledgeRepository(database);
const knowledgeEmbeddings = new KnowledgeEmbeddingRepository(database);
const workflowRepository = new WorkflowRepository(database);
const workflowService = new WorkflowService(workflowRepository);

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

  it("ranks semantic memories inside the active owner boundary", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const [otherActor] = await database.db.insert(users).values({}).returning();
    const related = await memories.create(actorId, {
      kind: "preference",
      content: "Prefers TypeScript",
    });
    const unrelated = await memories.create(actorId, {
      kind: "note",
      content: "Prefers morning meetings",
    });
    const foreign = await memories.create(otherActor!.id, {
      kind: "fact",
      content: "Uses TypeScript",
    });
    const axis = (index: number) =>
      Array.from({ length: 384 }, (_, position) =>
        position === index ? 1 : 0,
      );
    await memoryEmbeddings.upsert(related.id, "test-model", axis(0));
    await memoryEmbeddings.upsert(unrelated.id, "test-model", axis(1));
    await memoryEmbeddings.upsert(foreign.id, "test-model", axis(0));

    await expect(
      memoryEmbeddings.searchOwned(actorId, "test-model", axis(0), 5, 0.5),
    ).resolves.toEqual([
      expect.objectContaining({
        id: related.id,
        content: "Prefers TypeScript",
      }),
    ]);
    await memories.deleteOwned(actorId, related.id, new Date());
    await expect(
      memoryEmbeddings.searchOwned(actorId, "test-model", axis(0), 5, 0.5),
    ).resolves.toEqual([]);
  });

  it("enforces the memory user foreign key", async () => {
    await expect(
      memories.create("00000000-0000-4000-8000-000000000099", {
        kind: "fact",
        content: "Cannot belong to an absent user",
      }),
    ).rejects.toBeDefined();
  });

  it("transactionally persists owner-scoped knowledge and deterministic chunks", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const [otherActor] = await database.db.insert(users).values({}).returning();
    const created = await knowledge.createTransactional(actorId, {
      title: "Architecture",
      sourceType: "file_txt",
      normalizedContent: "First paragraph.\n\nSecond paragraph.",
      contentHash: sha256("First paragraph.\n\nSecond paragraph."),
      chunks: [
        {
          ordinal: 0,
          content: "First paragraph.",
          contentHash: sha256("First paragraph."),
        },
        {
          ordinal: 1,
          content: "Second paragraph.",
          contentHash: sha256("Second paragraph."),
        },
      ],
    });
    await expect(
      knowledge.getOwned(actorId, created.id),
    ).resolves.toMatchObject({
      actorId,
      sourceType: "file_txt",
      status: "ACTIVE",
      chunkCount: 2,
    });
    await expect(
      knowledge.getOwned(otherActor!.id, created.id),
    ).resolves.toBeUndefined();
    await expect(knowledge.listOwned(otherActor!.id, 20)).resolves.toEqual([]);
    await expect(
      knowledge.listOwnedActiveChunks(actorId, created.id),
    ).resolves.toEqual([
      expect.objectContaining({ ordinal: 0, content: "First paragraph." }),
      expect.objectContaining({ ordinal: 1, content: "Second paragraph." }),
    ]);
  });

  it("rolls back the document when any chunk insert fails", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    await expect(
      knowledge.createTransactional(actorId, {
        title: "Rollback",
        normalizedContent: "Valid normalized document",
        contentHash: sha256("Valid normalized document"),
        chunks: [
          {
            ordinal: 0,
            content: "x".repeat(2001),
            contentHash: sha256("x".repeat(2001)),
          },
        ],
      }),
    ).rejects.toBeDefined();
    await expect(
      database.db.select().from(knowledgeDocuments),
    ).resolves.toEqual([]);
    await expect(database.db.select().from(knowledgeChunks)).resolves.toEqual(
      [],
    );
  });

  it("soft-deletes owned knowledge and makes retained chunks inaccessible", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const [otherActor] = await database.db.insert(users).values({}).returning();
    const create = (title: string) =>
      knowledge.createTransactional(actorId, {
        title,
        normalizedContent: title,
        contentHash: sha256(title),
        chunks: [{ ordinal: 0, content: title, contentHash: sha256(title) }],
      });
    const older = await create("Older");
    const newer = await create("Newer");
    const olderAt = new Date("2026-08-19T00:00:00Z");
    const newerAt = new Date("2026-08-20T00:00:00Z");
    await database.db
      .update(knowledgeDocuments)
      .set({ createdAt: olderAt })
      .where(eq(knowledgeDocuments.id, older.id));
    await database.db
      .update(knowledgeDocuments)
      .set({ createdAt: newerAt })
      .where(eq(knowledgeDocuments.id, newer.id));
    await expect(knowledge.listOwned(actorId, 1)).resolves.toEqual([
      expect.objectContaining({ id: newer.id }),
    ]);
    await expect(
      knowledge.deleteOwned(otherActor!.id, newer.id, new Date()),
    ).resolves.toBeUndefined();
    await expect(
      knowledge.deleteOwned(actorId, newer.id, newerAt),
    ).resolves.toEqual({ id: newer.id });
    await expect(
      knowledge.deleteOwned(actorId, newer.id, newerAt),
    ).resolves.toBeUndefined();
    await expect(
      knowledge.getOwned(actorId, newer.id),
    ).resolves.toBeUndefined();
    await expect(
      knowledge.listOwnedActiveChunks(actorId, newer.id),
    ).resolves.toEqual([]);
    expect(await database.db.select().from(knowledgeChunks)).toHaveLength(2);
  });

  it("upserts model-aware chunk vectors and selects only ACTIVE missing chunks", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const create = (title: string) =>
      knowledge.createTransactional(actorId, {
        title,
        normalizedContent: title,
        contentHash: sha256(title),
        chunks: [{ ordinal: 0, content: title, contentHash: sha256(title) }],
      });
    const active = await create("Active chunk");
    const deleted = await create("Deleted chunk");
    const activeChunk = active.chunks[0]!;
    const vector = Array.from({ length: 384 }, () => 0.25);

    await knowledgeEmbeddings.upsert(activeChunk.id, "model-a", vector);
    await knowledgeEmbeddings.upsert(activeChunk.id, "model-a", vector);
    await knowledgeEmbeddings.upsert(activeChunk.id, "model-b", vector);
    expect(
      await database.db.select().from(knowledgeChunkEmbeddings),
    ).toHaveLength(2);
    await knowledge.deleteOwned(actorId, deleted.id, new Date());
    await expect(
      knowledgeEmbeddings.listActiveMissing("model-a", 25),
    ).resolves.toEqual([]);
    await expect(
      knowledgeEmbeddings.listActiveMissing("model-c", 1),
    ).resolves.toEqual([
      expect.objectContaining({
        id: activeChunk.id,
        documentId: active.id,
        content: "Active chunk",
      }),
    ]);
    await expect(
      knowledgeEmbeddings.upsert(activeChunk.id, "model-a", [1, 2]),
    ).rejects.toThrow("Invalid knowledge embedding vector");
  });

  it("performs cosine knowledge retrieval inside owner, lifecycle, and model boundaries", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const [otherActor] = await database.db.insert(users).values({}).returning();
    const create = (owner: string, title: string) =>
      knowledge.createTransactional(owner, {
        title,
        normalizedContent: title,
        contentHash: sha256(title),
        chunks: [{ ordinal: 0, content: title, contentHash: sha256(title) }],
      });
    const exactA = await create(actorId, "Exact A");
    const exactB = await create(actorId, "Exact B");
    const related = await create(actorId, "Related");
    const unrelated = await create(actorId, "Unrelated");
    const wrongModel = await create(actorId, "Wrong model");
    const unembedded = await create(actorId, "Unembedded");
    const deleted = await create(actorId, "Deleted");
    const foreign = await create(otherActor!.id, "Foreign");
    const axis = (first: number, second = 0) => [
      first,
      second,
      ...Array.from({ length: 382 }, () => 0),
    ];
    for (const document of [exactA, exactB])
      await knowledgeEmbeddings.upsert(
        document.chunks[0]!.id,
        "current-model",
        axis(1),
      );
    await knowledgeEmbeddings.upsert(
      related.chunks[0]!.id,
      "current-model",
      axis(0.8, 0.6),
    );
    await knowledgeEmbeddings.upsert(
      unrelated.chunks[0]!.id,
      "current-model",
      axis(0, 1),
    );
    await knowledgeEmbeddings.upsert(
      wrongModel.chunks[0]!.id,
      "old-model",
      axis(1),
    );
    await knowledgeEmbeddings.upsert(
      deleted.chunks[0]!.id,
      "current-model",
      axis(1),
    );
    await knowledgeEmbeddings.upsert(
      foreign.chunks[0]!.id,
      "current-model",
      axis(1),
    );
    await knowledge.deleteOwned(actorId, deleted.id, new Date());

    const results = await knowledgeEmbeddings.searchOwned(
      actorId,
      "current-model",
      axis(1),
      10,
      0.5,
    );
    const exactIds = [exactA.id, exactB.id].sort();
    expect(results.map((result) => result.documentId)).toEqual([
      ...exactIds,
      related.id,
    ]);
    expect(results.map((result) => result.title)).not.toEqual(
      expect.arrayContaining([
        unrelated.title,
        wrongModel.title,
        unembedded.title,
        deleted.title,
        foreign.title,
      ]),
    );
    expect(results[0]!.similarity).toBeCloseTo(1);
    expect(results[2]!.similarity).toBeCloseTo(0.8);
    await expect(
      knowledgeEmbeddings.searchOwned(
        actorId,
        "current-model",
        axis(1),
        1,
        0.5,
      ),
    ).resolves.toHaveLength(1);
  });

  it("persists and reconstructs an actor-owned workflow graph atomically", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const created = await workflowService.create(actorId, {
      type: "workflow",
      goal: "Prepare for the meeting",
      steps: [
        {
          id: "meeting",
          kind: "tool",
          dependsOn: [],
          tool: { name: "calendar.events.list", input: { maxResults: 1 } },
        },
        {
          id: "notes",
          kind: "knowledge_search",
          dependsOn: ["meeting"],
          query: "project notes",
        },
      ],
    });
    expect(created.status).toBe("READY");
    expect(
      created.steps.map((step) => [step.stepKey, step.status, step.dependsOn]),
    ).toEqual([
      ["meeting", "READY", []],
      ["notes", "BLOCKED", ["meeting"]],
    ]);
    const recreated = new WorkflowService(new WorkflowRepository(database));
    await expect(recreated.getOwned(actorId, created.id)).resolves.toEqual(
      created,
    );
    expect(await database.db.select().from(workflows)).toHaveLength(1);
    expect(await database.db.select().from(workflowSteps)).toHaveLength(2);
    expect(
      await database.db.select().from(workflowStepDependencies),
    ).toHaveLength(1);
  });

  it("keeps foreign workflows indistinguishable and cancellation idempotent", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const [other] = await database.db
      .insert(users)
      .values({ developmentKey: "workflow-other" })
      .returning();
    const created = await workflowService.create(actorId, {
      type: "workflow",
      goal: "Read saved preferences",
      steps: [
        {
          id: "preferences",
          kind: "memory_read",
          dependsOn: [],
          memoryKind: null,
        },
      ],
    });
    await expect(
      workflowService.getOwned(other!.id, created.id),
    ).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
    await expect(
      workflowService.cancelOwned(other!.id, created.id),
    ).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
    const first = await workflowService.cancelOwned(actorId, created.id);
    const second = await workflowService.cancelOwned(actorId, created.id);
    expect(first.status).toBe("CANCELLED");
    expect(first.steps[0]?.status).toBe("CANCELLED");
    expect(second).toEqual(first);
    await expect(workflowService.listOwned(other!.id, 20)).resolves.toEqual([]);
  });

  it("cascades durable steps and dependencies with workflow deletion", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const created = await workflowService.create(actorId, {
      type: "workflow",
      goal: "Ordered reads",
      steps: [
        {
          id: "memory",
          kind: "memory_search",
          dependsOn: [],
          query: "preferences",
        },
        {
          id: "knowledge",
          kind: "knowledge_search",
          dependsOn: ["memory"],
          query: "notes",
        },
      ],
    });
    await database.db.delete(workflows).where(eq(workflows.id, created.id));
    await expect(database.db.select().from(workflowSteps)).resolves.toEqual([]);
    await expect(
      database.db.select().from(workflowStepDependencies),
    ).resolves.toEqual([]);
  });

  it("rolls back the complete graph when dependency persistence fails", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    await expect(
      database.db.transaction(async (transaction) => {
        const [workflow] = await transaction
          .insert(workflows)
          .values({ actorId, goal: "Rollback dependency failure" })
          .returning();
        const steps = await transaction
          .insert(workflowSteps)
          .values([
            {
              workflowId: workflow!.id,
              stepKey: "first",
              kind: "memory_read",
              ordinal: 0,
              status: "READY",
              payload: { memoryKind: null },
            },
            {
              workflowId: workflow!.id,
              stepKey: "second",
              kind: "knowledge_search",
              ordinal: 1,
              status: "BLOCKED",
              payload: { query: "notes" },
            },
          ])
          .returning();
        await transaction.insert(workflowStepDependencies).values({
          workflowId: workflow!.id,
          stepId: steps[1]!.id,
          dependsOnStepId: "00000000-0000-4000-8000-000000000999",
        });
      }),
    ).rejects.toBeDefined();
    await expect(
      database.db
        .select()
        .from(workflows)
        .where(eq(workflows.goal, "Rollback dependency failure")),
    ).resolves.toEqual([]);
  });

  it("atomically claims one workflow step and forbids attempt two", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const created = await workflowService.create(actorId, {
      type: "workflow",
      goal: "Claim exactly once",
      steps: [
        { id: "read", kind: "memory_read", dependsOn: [], memoryKind: null },
      ],
    });
    const claims = await Promise.all([
      workflowRepository.startOwned(actorId, created.id, new Date()),
      workflowRepository.startOwned(actorId, created.id, new Date()),
    ]);
    expect(claims.filter((claim) => claim?.claimed)).toHaveLength(1);
    const steps = await Promise.all([
      workflowRepository.claimNext(created.id, new Date()),
      workflowRepository.claimNext(created.id, new Date()),
    ]);
    expect(steps.filter(Boolean)).toHaveLength(1);
    const [execution] = await database.db.select().from(workflowStepExecutions);
    expect(execution?.attemptNumber).toBe(1);
    await expect(
      database.db.insert(workflowStepExecutions).values({
        workflowId: created.id,
        stepId: execution!.stepId,
        attemptNumber: 2,
        status: "RUNNING",
      }),
    ).rejects.toBeDefined();
  });

  it("executes dependency-ready account-data steps sequentially to completion", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const created = await workflowService.create(actorId, {
      type: "workflow",
      goal: "Read memory then knowledge",
      steps: [
        { id: "memory", kind: "memory_read", dependsOn: [], memoryKind: null },
        {
          id: "knowledge",
          kind: "knowledge_search",
          dependsOn: ["memory"],
          query: "notes",
        },
      ],
    });
    const calls: string[] = [];
    const executor = new WorkflowExecutor(
      workflowRepository,
      workflowService,
      {
        execute: () => Promise.reject(new Error("unexpected Tool execution")),
      },
      {
        create: () => Promise.reject(new Error("unexpected approval")),
      },
      {
        create: () => Promise.reject(new Error("unexpected write")),
        getOwned: () => Promise.reject(new Error("unexpected get")),
        listOwned: () => {
          calls.push("memory");
          return Promise.resolve([]);
        },
        deleteOwned: () => Promise.reject(new Error("unexpected delete")),
      },
      {
        searchOwned: () => {
          calls.push("knowledge");
          return Promise.resolve([]);
        },
      },
    );
    const result = await executor.run(
      actorId,
      created.id,
      {
        actorId,
        grantedPermissions: ["workflow.write", "memory.read", "knowledge.read"],
      },
      "workflow-run-1",
    );
    expect(calls).toEqual(["memory", "knowledge"]);
    expect(result.status).toBe("COMPLETED");
    expect(result.steps.map((step) => step.status)).toEqual([
      "SUCCEEDED",
      "SUCCEEDED",
    ]);
    expect(result.steps.every((step) => step.hasResult)).toBe(true);
  });

  it("resolves a persisted scalar ancestor reference without mutating its template", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const reference = { fromStep: "calculate", field: "result" };
    const created = await workflowService.create(actorId, {
      type: "workflow",
      goal: "Calculate a bounded list size",
      steps: [
        {
          id: "calculate",
          kind: "tool",
          dependsOn: [],
          tool: { name: "utility.calculator", input: { expression: "1+2" } },
        },
        {
          id: "list",
          kind: "tool",
          dependsOn: ["calculate"],
          tool: {
            name: "calendar.events.list",
            input: {
              timeMin: "2026-01-01T00:00:00Z",
              timeMax: "2026-01-02T00:00:00Z",
              maxResults: reference,
            },
          },
        },
      ],
    });
    const dispatched: unknown[] = [];
    const executor = new WorkflowExecutor(
      new WorkflowRepository(database),
      new WorkflowService(new WorkflowRepository(database)),
      {
        prepare: (request) =>
          Promise.resolve(preparation(request, "IDEMPOTENT")),
        execute: (request) => {
          dispatched.push(request);
          return Promise.resolve({
            status: "success" as const,
            tool: request.tool,
            data:
              request.tool === "utility.calculator"
                ? { expression: "1+2", result: 3 }
                : { events: [] },
          });
        },
      },
      { create: () => Promise.reject(new Error("unexpected approval")) },
      {
        create: () => Promise.reject(new Error("unexpected memory")),
        getOwned: () => Promise.reject(new Error("unexpected memory")),
        listOwned: () => Promise.reject(new Error("unexpected memory")),
        deleteOwned: () => Promise.reject(new Error("unexpected memory")),
      },
      { searchOwned: () => Promise.reject(new Error("unexpected knowledge")) },
    );
    const completed = await executor.run(
      actorId,
      created.id,
      { actorId, grantedPermissions: ["workflow.write"] },
      "workflow-reference-1",
    );
    expect(completed.status).toBe("COMPLETED");
    expect(dispatched).toEqual([
      { tool: "utility.calculator", input: { expression: "1+2" } },
      {
        tool: "calendar.events.list",
        input: {
          timeMin: "2026-01-01T00:00:00Z",
          timeMax: "2026-01-02T00:00:00Z",
          maxResults: 3,
        },
      },
    ]);
    const graph = await new WorkflowRepository(database).getOwned(
      actorId,
      created.id,
    );
    const persistedInput = (
      graph!.steps[1]!.payload as {
        tool: { input: Record<string, unknown> };
      }
    ).tool.input;
    expect(persistedInput.maxResults).toEqual(reference);
    expect(graph!.executions[0]!.result).toEqual({
      expression: "1+2",
      result: 3,
    });
  });

  it("binds an approval to resolved input and resumes that exact action", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const created = await workflowService.create(actorId, {
      type: "workflow",
      goal: "Calculate then list",
      steps: [
        {
          id: "calculate",
          kind: "tool",
          dependsOn: [],
          tool: { name: "utility.calculator", input: { expression: "2+2" } },
        },
        {
          id: "list",
          kind: "tool",
          dependsOn: ["calculate"],
          tool: {
            name: "calendar.events.list",
            input: {
              timeMin: "2026-01-01T00:00:00Z",
              timeMax: "2026-01-02T00:00:00Z",
              maxResults: { fromStep: "calculate", field: "result" },
            },
          },
        },
      ],
    });
    const executions: unknown[] = [];
    const executor = new WorkflowExecutor(
      workflowRepository,
      workflowService,
      {
        execute: (request) => {
          executions.push(request);
          return Promise.resolve({
            status: "success" as const,
            tool: request.tool,
            data:
              request.tool === "utility.calculator"
                ? { expression: "2+2", result: 4 }
                : { events: [] },
          });
        },
        prepare: (request) =>
          Promise.resolve({
            tool: request.tool,
            version: 1,
            title: "Workflow tool",
            approvalPolicy:
              request.tool === "calendar.events.list"
                ? ("REQUIRED" as const)
                : ("NONE" as const),
            idempotency: "IDEMPOTENT" as const,
            input: request.input,
            inputDigest: "a".repeat(64),
            preview: "safe preview",
          }),
      },
      approvals,
      {
        create: () => Promise.reject(new Error("unexpected memory")),
        getOwned: () => Promise.reject(new Error("unexpected memory")),
        listOwned: () => Promise.reject(new Error("unexpected memory")),
        deleteOwned: () => Promise.reject(new Error("unexpected memory")),
      },
      { searchOwned: () => Promise.reject(new Error("unexpected knowledge")) },
    );
    const waiting = await executor.run(
      actorId,
      created.id,
      { actorId, grantedPermissions: ["workflow.write"] },
      "workflow-reference-approval",
    );
    expect(waiting.status).toBe("AWAITING_APPROVAL");
    const [approval] = await database.db.select().from(toolApprovals);
    expect(approval!.inputEnvelope).toMatchObject({ maxResults: 4 });
    expect(approval!.inputDigest).toBe("a".repeat(64));
    await expect(
      executor.recover(
        actorId,
        created.id,
        { actorId, grantedPermissions: ["workflow.write"] },
        "workflow-reference-pending",
      ),
    ).resolves.toMatchObject({ status: "AWAITING_APPROVAL" });
    expect(await database.db.select().from(toolApprovals)).toHaveLength(1);
    await database.db
      .update(toolApprovals)
      .set({
        status: "CONSUMED",
        consumedAt: new Date(),
        decidedAt: new Date(),
      })
      .where(eq(toolApprovals.id, approval!.id));
    const completed = await executor.recover(
      actorId,
      created.id,
      { actorId, grantedPermissions: ["workflow.write"] },
      "workflow-reference-approved",
    );
    expect(completed.status).toBe("COMPLETED");
    expect(executions.at(-1)).toMatchObject({ input: { maxResults: 4 } });
  });

  it("recovers one stale idempotent attempt after repository recreation", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const created = await workflowService.create(actorId, {
      type: "workflow",
      goal: "Recover calculator",
      steps: [
        {
          id: "calculate",
          kind: "tool",
          dependsOn: [],
          tool: { name: "utility.calculator", input: { expression: "4+5" } },
        },
      ],
    });
    const old = new Date("2026-01-01T00:00:00.000Z");
    await workflowRepository.startOwned(actorId, created.id, old);
    const claimed = await workflowRepository.claimNext(created.id, old);
    await workflowRepository.checkpoint(
      claimed!.execution.id,
      ["CLAIMED"],
      "PREPARED",
      old,
    );
    let dispatches = 0;
    const recreatedRepository = new WorkflowRepository(database);
    const recreatedService = new WorkflowService(recreatedRepository);
    const recovered = await new WorkflowExecutor(
      recreatedRepository,
      recreatedService,
      {
        prepare: (request) =>
          Promise.resolve(preparation(request, "IDEMPOTENT")),
        execute: (request) => {
          dispatches += 1;
          return Promise.resolve({
            status: "success" as const,
            tool: request.tool,
            data: { expression: "4+5", result: 9 },
          });
        },
      },
      approvals,
      unexpectedMemories(),
      unexpectedKnowledge(),
      300,
      10_000,
      () => new Date("2026-01-01T00:01:00.000Z"),
    ).recover(
      actorId,
      created.id,
      { actorId, grantedPermissions: ["workflow.write", "utility.calculator"] },
      "recover-safe",
    );
    expect(recovered.status).toBe("COMPLETED");
    expect(dispatches).toBe(1);
    const executions = await database.db.select().from(workflowStepExecutions);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      attemptNumber: 1,
      status: "SUCCEEDED",
      checkpoint: "FINALIZED",
      result: { expression: "4+5", result: 9 },
    });
  });

  it("reconciles a persisted dispatch result without executing again", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const created = await workflowService.create(actorId, {
      type: "workflow",
      goal: "Reconcile calculator",
      steps: [
        {
          id: "calculate",
          kind: "tool",
          dependsOn: [],
          tool: { name: "utility.calculator", input: { expression: "2+3" } },
        },
      ],
    });
    const old = new Date("2026-01-01T00:00:00.000Z");
    await workflowRepository.startOwned(actorId, created.id, old);
    const claimed = await workflowRepository.claimNext(created.id, old);
    await workflowRepository.checkpoint(
      claimed!.execution.id,
      ["CLAIMED"],
      "PREPARED",
      old,
    );
    await workflowRepository.checkpoint(
      claimed!.execution.id,
      ["PREPARED"],
      "DISPATCH_PENDING",
      old,
    );
    await workflowRepository.recordDispatchedResult(
      claimed!.execution.id,
      { expression: "2+3", result: 5 },
      old,
    );
    const recreatedRepository = new WorkflowRepository(database);
    const recovered = await new WorkflowExecutor(
      recreatedRepository,
      new WorkflowService(recreatedRepository),
      {
        prepare: () => Promise.reject(new Error("must not prepare")),
        execute: () => Promise.reject(new Error("must not dispatch")),
      },
      approvals,
      unexpectedMemories(),
      unexpectedKnowledge(),
      300,
      10_000,
      () => new Date("2026-01-01T00:01:00.000Z"),
    ).recover(
      actorId,
      created.id,
      { actorId, grantedPermissions: ["workflow.write"] },
      "recover-result",
    );
    expect(recovered.status).toBe("COMPLETED");
    expect(
      await database.db.select().from(workflowStepExecutions),
    ).toHaveLength(1);
  });

  it("marks a possibly dispatched non-idempotent action ambiguous without replay", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const created = await workflowService.create(actorId, {
      type: "workflow",
      goal: "Do not repeat a mutation",
      steps: [
        {
          id: "send",
          kind: "tool",
          dependsOn: [],
          tool: {
            name: "gmail.messages.send",
            input: { to: "user@example.com", subject: "Test", body: "Body" },
          },
        },
      ],
    });
    const old = new Date("2026-01-01T00:00:00.000Z");
    await workflowRepository.startOwned(actorId, created.id, old);
    const claimed = await workflowRepository.claimNext(created.id, old);
    await workflowRepository.checkpoint(
      claimed!.execution.id,
      ["CLAIMED"],
      "PREPARED",
      old,
    );
    await workflowRepository.checkpoint(
      claimed!.execution.id,
      ["PREPARED"],
      "DISPATCH_PENDING",
      old,
    );
    let dispatches = 0;
    const recreatedRepository = new WorkflowRepository(database);
    const executor = new WorkflowExecutor(
      recreatedRepository,
      new WorkflowService(recreatedRepository),
      {
        prepare: (request) =>
          Promise.resolve(preparation(request, "NON_IDEMPOTENT")),
        execute: () => {
          dispatches += 1;
          return Promise.reject(new Error("must not dispatch"));
        },
      },
      approvals,
      unexpectedMemories(),
      unexpectedKnowledge(),
      300,
      10_000,
      () => new Date("2026-01-01T00:01:00.000Z"),
    );
    const recovered = await executor.recover(
      actorId,
      created.id,
      {
        actorId,
        grantedPermissions: ["workflow.write", "gmail.messages.send"],
      },
      "recover-ambiguous",
    );
    expect(recovered.status).toBe("RECOVERY_REQUIRED");
    expect(recovered.steps[0]).toMatchObject({
      status: "RECOVERY_REQUIRED",
      errorCode: "WORKFLOW_EXECUTION_AMBIGUOUS",
    });
    expect(dispatches).toBe(0);
    await expect(
      executor.recover(
        actorId,
        created.id,
        {
          actorId,
          grantedPermissions: ["workflow.write", "gmail.messages.send"],
        },
        "recover-ambiguous-again",
      ),
    ).resolves.toMatchObject({ status: "RECOVERY_REQUIRED" });
    expect(
      await database.db.select().from(workflowStepExecutions),
    ).toHaveLength(1);
  });

  it("allows only one PostgreSQL recovery claimant", async () => {
    const actorId = await repository.bootstrapDevelopmentUser();
    const created = await workflowService.create(actorId, {
      type: "workflow",
      goal: "Race recovery",
      steps: [
        {
          id: "calculate",
          kind: "tool",
          dependsOn: [],
          tool: { name: "utility.calculator", input: { expression: "1+1" } },
        },
      ],
    });
    const old = new Date("2026-01-01T00:00:00.000Z");
    await workflowRepository.startOwned(actorId, created.id, old);
    await workflowRepository.claimNext(created.id, old);
    const now = new Date("2026-01-01T00:01:00.000Z");
    const claims = await Promise.all([
      new WorkflowRepository(database).claimRecoveryOwned(
        actorId,
        created.id,
        old,
        now,
      ),
      new WorkflowRepository(database).claimRecoveryOwned(
        actorId,
        created.id,
        old,
        now,
      ),
    ]);
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect(
      await database.db.select().from(workflowStepExecutions),
    ).toHaveLength(1);
  });
});

function preparation(
  request: { tool: string; input: unknown },
  idempotency: "IDEMPOTENT" | "NON_IDEMPOTENT",
) {
  return {
    tool: request.tool,
    version: 1,
    title: "Workflow tool",
    approvalPolicy: "NONE" as const,
    idempotency,
    input: request.input,
    inputDigest: "b".repeat(64),
    preview: "safe",
  };
}

function unexpectedMemories() {
  return {
    create: () => Promise.reject(new Error("unexpected memory")),
    getOwned: () => Promise.reject(new Error("unexpected memory")),
    listOwned: () => Promise.reject(new Error("unexpected memory")),
    deleteOwned: () => Promise.reject(new Error("unexpected memory")),
  };
}

function unexpectedKnowledge() {
  return {
    searchOwned: () => Promise.reject(new Error("unexpected knowledge")),
  };
}
