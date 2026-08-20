import { describe, expect, it, vi } from "vitest";

import type { EmbeddingClient } from "../src/memory/memory-embedding-client.js";
import type { KnowledgeEmbeddingRepository } from "../src/knowledge/knowledge-embedding-repository.js";
import type { KnowledgeRepository } from "../src/knowledge/knowledge-repository.js";
import { KnowledgeService } from "../src/knowledge/knowledge-service.js";

const now = new Date("2026-08-20T00:00:00Z");
const chunks = [
  {
    id: "00000000-0000-4000-8000-000000000021",
    documentId: "00000000-0000-4000-8000-000000000010",
    ordinal: 0,
    content: "secret chunk alpha",
  },
  {
    id: "00000000-0000-4000-8000-000000000022",
    documentId: "00000000-0000-4000-8000-000000000010",
    ordinal: 1,
    content: "secret chunk beta",
  },
] as const;

function stored() {
  return {
    id: chunks[0].documentId,
    actorId: "actor-a",
    title: "Private",
    sourceType: "manual_text" as const,
    status: "ACTIVE" as const,
    normalizedContent: "secret chunk alpha\n\nsecret chunk beta",
    contentHash: "a".repeat(64),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    chunkCount: 2,
    chunks,
  };
}

function runtime(options?: { failText?: string; delay?: boolean }) {
  let active = 0;
  let maximumActive = 0;
  const embed = vi.fn(async (text: string) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (options?.delay) await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (text === options?.failText) throw new Error("private provider failure");
    return Array.from({ length: 384 }, (_value, index) => index / 384);
  });
  const upsert = vi.fn((...parameters: [string, string, readonly number[]]) => {
    void parameters;
    return Promise.resolve();
  });
  const listActiveMissing = vi.fn(() => Promise.resolve([...chunks]));
  return {
    value: {
      client: {
        model: "local-embedding-model",
        dimensions: 384,
        embed,
      } satisfies EmbeddingClient,
      repository: {
        upsert,
        listActiveMissing,
      } as unknown as KnowledgeEmbeddingRepository,
      concurrency: 2,
      searchLimit: 5,
      minimumSimilarity: 0.5,
    },
    embed,
    upsert,
    listActiveMissing,
    maximumActive: () => maximumActive,
  };
}

describe("knowledge chunk indexing", () => {
  it("does nothing when embeddings are disabled and preserves the API shape", async () => {
    const repository = {
      createTransactional: vi.fn(() => Promise.resolve(stored())),
    } as unknown as KnowledgeRepository;
    const result = await new KnowledgeService(repository).create("actor-a", {
      title: "Private",
      content: "secret chunk alpha\n\nsecret chunk beta",
    });
    expect(result).not.toHaveProperty("chunks");
    expect(result).not.toHaveProperty("embedding");
  });

  it("persists successful vectors after commit with bounded concurrency", async () => {
    const embedding = runtime({ delay: true });
    const service = new KnowledgeService(
      {
        createTransactional: vi.fn(() => Promise.resolve(stored())),
      } as unknown as KnowledgeRepository,
      undefined,
      embedding.value,
    );
    await expect(
      service.create("actor-a", { title: "Private", content: "content" }),
    ).resolves.toMatchObject({ id: chunks[0].documentId });
    expect(embedding.embed).toHaveBeenCalledTimes(2);
    expect(embedding.upsert).toHaveBeenCalledTimes(2);
    expect(embedding.maximumActive()).toBeLessThanOrEqual(2);
    expect(embedding.upsert.mock.calls[0]?.[2]).toHaveLength(384);
  });

  it("keeps ingestion successful and preserves partial indexing failures", async () => {
    const info = vi.fn();
    const embedding = runtime({ failText: chunks[1].content });
    const service = new KnowledgeService(
      {
        createTransactional: vi.fn(() => Promise.resolve(stored())),
      } as unknown as KnowledgeRepository,
      { info },
      embedding.value,
    );
    await expect(
      service.create("actor-a", { title: "Private", content: "content" }),
    ).resolves.toMatchObject({ id: chunks[0].documentId });
    expect(embedding.upsert).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(info.mock.calls)).not.toContain("secret chunk");
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ embeddedCount: 1, failedCount: 1 }),
      expect.any(String),
    );
  });

  it("runs a bounded deterministic backfill and continues after failure", async () => {
    const embedding = runtime({ failText: chunks[0].content });
    const service = new KnowledgeService(
      {} as KnowledgeRepository,
      undefined,
      embedding.value,
    );
    await expect(service.backfill(2, "request-backfill")).resolves.toEqual({
      processed: 2,
      embedded: 1,
      failed: 1,
    });
    expect(embedding.listActiveMissing).toHaveBeenCalledWith(
      "local-embedding-model",
      2,
    );
    await expect(service.backfill(101)).rejects.toMatchObject({
      code: "KNOWLEDGE_INPUT_INVALID",
    });
  });

  it("reports backfill as unavailable when embeddings are disabled", async () => {
    await expect(
      new KnowledgeService({} as KnowledgeRepository).backfill(25),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_EMBEDDING_UNAVAILABLE" });
  });
});
