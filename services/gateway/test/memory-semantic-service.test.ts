import { describe, expect, it, vi } from "vitest";

import type { MemoryEmbeddingClient } from "../src/memory/memory-embedding-client.js";
import type { MemoryEmbeddingRepository } from "../src/memory/memory-embedding-repository.js";
import type { MemoryRepository } from "../src/memory/memory-repository.js";
import { MemoryService } from "../src/memory/memory-service.js";

const row = {
  id: "00000000-0000-4000-8000-000000000010",
  actorId: "actor-a",
  kind: "preference" as const,
  content: "Prefers TypeScript",
  source: "user_explicit" as const,
  status: "ACTIVE" as const,
  createdAt: new Date("2026-08-20T00:00:00Z"),
  updatedAt: new Date("2026-08-20T00:00:00Z"),
  deletedAt: null,
};

function client(
  embed: MemoryEmbeddingClient["embed"] = vi.fn(() =>
    Promise.resolve([1, 0, 0]),
  ),
) {
  return {
    model: "test",
    dimensions: 3,
    embed,
  } satisfies MemoryEmbeddingClient;
}

describe("semantic memory service", () => {
  it("keeps persistence successful when embedding fails", async () => {
    const create = vi.fn(() => Promise.resolve(row));
    const upsert = vi.fn();
    const service = new MemoryService(
      { create } as unknown as MemoryRepository,
      {
        client: client(vi.fn(() => Promise.reject(new Error("offline")))),
        repository: { upsert } as unknown as MemoryEmbeddingRepository,
        searchLimit: 5,
        minimumSimilarity: 0.5,
      },
    );
    await expect(
      service.create("actor-a", {
        kind: "preference",
        content: "Prefers TypeScript",
      }),
    ).resolves.toMatchObject({ id: row.id });
    expect(create).toHaveBeenCalledOnce();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("embeds and persists a valid vector after memory creation", async () => {
    const upsert = vi.fn(() => Promise.resolve());
    const service = new MemoryService(
      {
        create: vi.fn(() => Promise.resolve(row)),
      } as unknown as MemoryRepository,
      {
        client: client(),
        repository: { upsert } as unknown as MemoryEmbeddingRepository,
        searchLimit: 5,
        minimumSimilarity: 0.5,
      },
    );
    await service.create("actor-a", {
      kind: "preference",
      content: row.content,
    });
    expect(upsert).toHaveBeenCalledWith(row.id, "test", [1, 0, 0]);
  });

  it("uses server-owned search bounds and returns no vector or score", async () => {
    const searchOwned = vi.fn(() =>
      Promise.resolve([
        { id: row.id, kind: row.kind, content: row.content, similarity: 0.9 },
      ]),
    );
    const service = new MemoryService({} as MemoryRepository, {
      client: client(),
      repository: { searchOwned } as unknown as MemoryEmbeddingRepository,
      searchLimit: 5,
      minimumSimilarity: 0.6,
    });
    const result = await service.searchOwnedRelevant(
      "actor-a",
      "coding language",
      "r-1",
    );
    expect(searchOwned).toHaveBeenCalledWith(
      "actor-a",
      "test",
      [1, 0, 0],
      5,
      0.6,
    );
    expect(result).toEqual([
      { id: row.id, kind: row.kind, content: row.content },
    ]);
    expect(JSON.stringify(result)).not.toContain("similarity");
  });

  it("logs only semantic-search metadata", async () => {
    const info = vi.fn();
    const service = new MemoryService({} as MemoryRepository, {
      client: client(),
      repository: {
        searchOwned: vi.fn(() =>
          Promise.resolve([
            {
              id: row.id,
              kind: row.kind,
              content: row.content,
              similarity: 0.9,
            },
          ]),
        ),
      } as unknown as MemoryEmbeddingRepository,
      searchLimit: 5,
      minimumSimilarity: 0.5,
      log: { info, warn: vi.fn() },
    });
    await service.searchOwnedRelevant(
      "actor-a",
      "private semantic query",
      "r-1",
    );
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain("private semantic query");
    expect(logged).not.toContain(row.content);
    expect(logged).not.toContain("[1,0,0]");
    expect(logged).toContain("memory_search");
  });

  it("backfills a bounded active/missing batch and tolerates partial failure", async () => {
    const listActiveMissing = vi.fn(() =>
      Promise.resolve([
        { id: "one", content: "one" },
        { id: "two", content: "two" },
      ]),
    );
    const embed = vi
      .fn<MemoryEmbeddingClient["embed"]>()
      .mockResolvedValueOnce([1, 0, 0])
      .mockRejectedValueOnce(new Error("offline"));
    const upsert = vi.fn(() => Promise.resolve());
    const service = new MemoryService({} as MemoryRepository, {
      client: client(embed),
      repository: {
        listActiveMissing,
        upsert,
      } as unknown as MemoryEmbeddingRepository,
      searchLimit: 5,
      minimumSimilarity: 0.5,
    });
    await expect(service.backfill(2)).resolves.toEqual({
      scanned: 2,
      embedded: 1,
      failed: 1,
    });
    expect(listActiveMissing).toHaveBeenCalledWith("test", 2);
    expect(upsert).toHaveBeenCalledOnce();
  });
});
