import { describe, expect, it, vi } from "vitest";

import type { MemoryRepository } from "../src/memory/memory-repository.js";
import { MemoryService } from "../src/memory/memory-service.js";

describe("memory service errors", () => {
  it("normalizes and validates writes at the shared service boundary", async () => {
    const create = vi.fn(() =>
      Promise.resolve({
        id: crypto.randomUUID(),
        kind: "preference" as const,
        content: "Prefer concise answers",
        source: "user_explicit" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const service = new MemoryService({
      create,
    } as unknown as MemoryRepository);
    await service.create("actor", {
      kind: "preference",
      content: "  Prefer concise answers  ",
    });
    expect(create).toHaveBeenCalledWith("actor", {
      kind: "preference",
      content: "Prefer concise answers",
    });
    for (const input of [
      { kind: "unknown", content: "x" },
      { kind: "note", content: "   " },
      { kind: "note", content: "x".repeat(4097) },
      { kind: "note", content: "unsafe\u0000content" },
    ]) {
      await expect(
        service.create("actor", input as never),
      ).rejects.toMatchObject({ code: "MEMORY_INPUT_INVALID" });
    }
  });

  it("bounds reads at the shared service boundary", async () => {
    const listOwned = vi.fn(() => Promise.resolve([]));
    const service = new MemoryService({
      listOwned,
    } as unknown as MemoryRepository);
    await expect(
      service.listOwned("actor", { limit: 51 }),
    ).rejects.toMatchObject({ code: "MEMORY_INPUT_INVALID" });
    await expect(
      service.listOwned("actor", { limit: 1, kind: "unknown" as never }),
    ).rejects.toMatchObject({ code: "MEMORY_INPUT_INVALID" });
    expect(listOwned).not.toHaveBeenCalled();
  });

  it("uses one not-found result for absent or non-owned records", async () => {
    const service = new MemoryService({
      getOwned: () => Promise.resolve(undefined),
    } as unknown as MemoryRepository);
    await expect(
      service.getOwned("actor", crypto.randomUUID()),
    ).rejects.toMatchObject({
      code: "MEMORY_NOT_FOUND",
      httpStatus: 404,
      message: "Memory not found",
    });
  });

  it("sanitizes persistence failures without retaining content or SQL details", async () => {
    const privateContent = "private-memory-content";
    const service = new MemoryService({
      create: () =>
        Promise.reject(
          new Error(`insert into user_memories values (${privateContent})`),
        ),
    } as unknown as MemoryRepository);
    const failure: unknown = await service
      .create("actor", { kind: "note", content: privateContent })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "MEMORY_STORAGE_FAILED",
      httpStatus: 500,
      message: "Memory storage operation failed",
    });
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error)
      expect(failure.message).not.toContain(privateContent);
  });
});
