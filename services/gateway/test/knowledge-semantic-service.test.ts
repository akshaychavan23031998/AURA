import { describe, expect, it, vi } from "vitest";

import type { EmbeddingClient } from "../src/memory/memory-embedding-client.js";
import type { KnowledgeEmbeddingRepository } from "../src/knowledge/knowledge-embedding-repository.js";
import type { KnowledgeRepository } from "../src/knowledge/knowledge-repository.js";
import { KnowledgeService } from "../src/knowledge/knowledge-service.js";

const vector = Array.from({ length: 384 }, (_value, index) => index / 384);
const row = {
  documentId: "00000000-0000-4000-8000-000000000010",
  chunkId: "00000000-0000-4000-8000-000000000011",
  title: "TOP_SECRET_TITLE_4A2C",
  content: "TOP_SECRET_CHUNK_7D3E",
  ordinal: 2,
  similarity: 0.91,
};

function runtime(options?: {
  embedFailure?: boolean;
  malformedVector?: boolean;
  searchFailure?: boolean;
  rows?: (typeof row)[];
}) {
  const embed = vi.fn((text: string, requestId: string) => {
    void text;
    void requestId;
    return options?.embedFailure
      ? Promise.reject(new Error("http://private-embedding-host"))
      : Promise.resolve(options?.malformedVector ? [1, 2] : vector);
  });
  const searchOwned = vi.fn(
    (...parameters: [string, string, readonly number[], number, number]) => {
      void parameters;
      return options?.searchFailure
        ? Promise.reject(new Error("knowledge_chunk_embeddings failed"))
        : Promise.resolve(options?.rows ?? [row]);
    },
  );
  return {
    embed,
    searchOwned,
    value: {
      client: {
        model: "fixed-current-model",
        dimensions: 384,
        embed,
      } satisfies EmbeddingClient,
      repository: { searchOwned } as unknown as KnowledgeEmbeddingRepository,
      concurrency: 2,
      searchLimit: 5,
      minimumSimilarity: 0.6,
    },
  };
}

describe("semantic knowledge service", () => {
  it("uses the fixed model and server-controlled search bounds", async () => {
    const embedding = runtime();
    const service = new KnowledgeService(
      {} as KnowledgeRepository,
      undefined,
      embedding.value,
    );
    const result = await service.searchOwned(
      "actor-a",
      "  deployment procedure  ",
      "request-search",
    );
    expect(embedding.embed).toHaveBeenCalledWith(
      "deployment procedure",
      "request-search",
    );
    expect(embedding.searchOwned).toHaveBeenCalledWith(
      "actor-a",
      "fixed-current-model",
      vector,
      5,
      0.6,
    );
    expect(result).toEqual([
      {
        documentId: row.documentId,
        chunkId: row.chunkId,
        title: row.title,
        content: row.content,
        ordinal: row.ordinal,
      },
    ]);
    expect(result[0]).not.toHaveProperty("similarity");
    expect(result[0]).not.toHaveProperty("model");
    expect(result[0]).not.toHaveProperty("embedding");
  });

  it.each(["", "   ", "x".repeat(1025), "unsafe\0query", "unsafe\u0001query"])(
    "rejects invalid semantic queries before embedding",
    async (query) => {
      const embedding = runtime();
      const service = new KnowledgeService(
        {} as KnowledgeRepository,
        undefined,
        embedding.value,
      );
      await expect(service.searchOwned("actor-a", query)).rejects.toMatchObject(
        { code: "KNOWLEDGE_INPUT_INVALID" },
      );
      expect(embedding.embed).not.toHaveBeenCalled();
      expect(embedding.searchOwned).not.toHaveBeenCalled();
    },
  );

  it("returns an empty result without fallback", async () => {
    const embedding = runtime({ rows: [] });
    const service = new KnowledgeService(
      {} as KnowledgeRepository,
      undefined,
      embedding.value,
    );
    await expect(
      service.searchOwned("actor-a", "unknown topic"),
    ).resolves.toEqual([]);
  });

  it("fails safely when embeddings are disabled or unavailable", async () => {
    await expect(
      new KnowledgeService({} as KnowledgeRepository).searchOwned(
        "actor-a",
        "deployment",
      ),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_SEARCH_UNAVAILABLE" });
    const embedding = runtime({ embedFailure: true });
    await expect(
      new KnowledgeService(
        {} as KnowledgeRepository,
        undefined,
        embedding.value,
      ).searchOwned("actor-a", "deployment"),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_SEARCH_UNAVAILABLE",
      message: "Knowledge search is unavailable",
    });
    const malformed = runtime({ malformedVector: true });
    await expect(
      new KnowledgeService(
        {} as KnowledgeRepository,
        undefined,
        malformed.value,
      ).searchOwned("actor-a", "deployment"),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_SEARCH_UNAVAILABLE" });
    expect(malformed.searchOwned).not.toHaveBeenCalled();
  });

  it("sanitizes database failures", async () => {
    const embedding = runtime({ searchFailure: true });
    await expect(
      new KnowledgeService(
        {} as KnowledgeRepository,
        undefined,
        embedding.value,
      ).searchOwned("actor-a", "deployment"),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_SEARCH_FAILED",
      message: "Knowledge search failed",
    });
  });

  it("logs only safe search metadata", async () => {
    const info = vi.fn();
    const embedding = runtime();
    await new KnowledgeService(
      {} as KnowledgeRepository,
      { info },
      embedding.value,
    ).searchOwned("actor-a", "TOP_SECRET_QUERY_8B1F", "request-safe-log");
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain("TOP_SECRET_QUERY_8B1F");
    expect(logged).not.toContain("TOP_SECRET_TITLE_4A2C");
    expect(logged).not.toContain("TOP_SECRET_CHUNK_7D3E");
    expect(logged).not.toContain(String(vector[1]));
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-safe-log",
        operation: "knowledge_search",
        resultCount: 1,
        outcome: "completed",
      }),
      expect.any(String),
    );
  });
});
