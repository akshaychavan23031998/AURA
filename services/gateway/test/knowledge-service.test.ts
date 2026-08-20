import { describe, expect, it, vi } from "vitest";

import type {
  KnowledgeRepository,
  PreparedKnowledgeDocument,
} from "../src/knowledge/knowledge-repository.js";
import {
  KnowledgeService,
  sha256,
} from "../src/knowledge/knowledge-service.js";
import {
  chunkKnowledgeText,
  KNOWLEDGE_CHUNK_MAX_CHARACTERS,
} from "../src/knowledge/text-chunker.js";
import { normalizeKnowledgeText } from "../src/knowledge/text-normalizer.js";

const now = new Date("2026-08-20T00:00:00Z");
const persisted = {
  id: "00000000-0000-4000-8000-000000000010",
  actorId: "actor-a",
  title: "Architecture",
  sourceType: "manual_text" as const,
  status: "ACTIVE" as const,
  normalizedContent: "First paragraph.\n\nSecond paragraph.",
  contentHash: "a".repeat(64),
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  chunkCount: 1,
};

describe("knowledge normalization and chunking", () => {
  it("normalizes line endings and surrounding whitespace deterministically", () => {
    const input = "  First\r\nline\r\rSecond  ";
    expect(normalizeKnowledgeText(input)).toBe("First\nline\n\nSecond");
    expect(normalizeKnowledgeText(input)).toBe(normalizeKnowledgeText(input));
  });

  it.each(["x\0y", "x\u0001y", "x\u007fy", " "])(
    "rejects unsafe or empty content",
    (content) => expect(() => normalizeKnowledgeText(content)).toThrow(),
  );

  it("enforces the normalized UTF-8 byte bound", () => {
    expect(() => normalizeKnowledgeText("é".repeat(65_537))).toThrow();
  });

  it("produces stable bounded non-empty chunks and ordinals", async () => {
    const content = `${"word ".repeat(500)}\n\n${"tail ".repeat(300)}`.trim();
    const first = chunkKnowledgeText(content);
    expect(first).toEqual(chunkKnowledgeText(content));
    expect(first.length).toBeGreaterThan(1);
    expect(first.every((chunk) => chunk.length > 0)).toBe(true);
    expect(
      first.every((chunk) => chunk.length <= KNOWLEDGE_CHUNK_MAX_CHARACTERS),
    ).toBe(true);

    let prepared: PreparedKnowledgeDocument | undefined;
    const service = new KnowledgeService({
      createTransactional: vi.fn(
        (_actorId: string, value: PreparedKnowledgeDocument) => {
          prepared = value;
          return Promise.resolve({
            ...persisted,
            chunkCount: value.chunks.length,
          });
        },
      ),
    } as unknown as KnowledgeRepository);
    await service.create("actor-a", { title: "Architecture", content });
    expect(prepared?.chunks.map((chunk) => chunk.ordinal)).toEqual(
      first.map((_chunk, ordinal) => ordinal),
    );
    expect(prepared?.chunks.map((chunk) => chunk.contentHash)).toEqual(
      first.map(sha256),
    );
  });

  it("fails safely when a document exceeds the chunk-count maximum", () => {
    const content = Array.from({ length: 129 }, () => "x".repeat(1000)).join(
      "\n\n",
    );
    expect(() => chunkKnowledgeText(content)).toThrow();
  });
});

describe("knowledge service", () => {
  it("returns only safe metadata and never logs title or content", async () => {
    const info = vi.fn();
    const createTransactional = vi.fn(
      (_actorId: string, value: PreparedKnowledgeDocument) =>
        Promise.resolve({ ...persisted, chunkCount: value.chunks.length }),
    );
    const service = new KnowledgeService(
      { createTransactional } as unknown as KnowledgeRepository,
      { info },
    );
    const result = await service.create(
      "actor-a",
      {
        title: "Private roadmap",
        content: "secret-document-content",
      },
      "request-1",
    );
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("actorId");
    expect(result).not.toHaveProperty("contentHash");
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain("Private roadmap");
    expect(logged).not.toContain("secret-document-content");
    expect(logged).not.toContain(sha256("secret-document-content"));
  });

  it("maps transactional failure to a sanitized ingestion error", async () => {
    const service = new KnowledgeService({
      createTransactional: vi.fn(() =>
        Promise.reject(new Error("knowledge_chunks constraint failed")),
      ),
    } as unknown as KnowledgeRepository);
    await expect(
      service.create("actor-a", { title: "Valid", content: "Valid content" }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "KNOWLEDGE_INGESTION_FAILED",
        message: "Knowledge ingestion failed",
      }),
    );
  });

  it("maps missing and non-owned records to the same not-found contract", async () => {
    const service = new KnowledgeService({
      getOwned: vi.fn(() => Promise.resolve(undefined)),
      deleteOwned: vi.fn(() => Promise.resolve(undefined)),
    } as unknown as KnowledgeRepository);
    await expect(
      service.getOwned("actor-a", persisted.id),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_NOT_FOUND",
      message: "Knowledge document not found",
    });
    await expect(
      service.deleteOwned("actor-a", persisted.id),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_NOT_FOUND",
      message: "Knowledge document not found",
    });
  });

  it("strips content and internal lifecycle metadata from list results", async () => {
    const service = new KnowledgeService({
      listOwned: vi.fn(() => Promise.resolve([persisted])),
    } as unknown as KnowledgeRepository);
    const result = await service.listOwned("actor-a", 20);
    expect(result).toEqual([expect.objectContaining({ id: persisted.id })]);
    expect(result[0]).not.toHaveProperty("normalizedContent");
    expect(result[0]).not.toHaveProperty("contentHash");
    expect(result[0]).not.toHaveProperty("actorId");
    expect(result[0]).not.toHaveProperty("status");
    expect(result[0]).not.toHaveProperty("deletedAt");
  });
});
