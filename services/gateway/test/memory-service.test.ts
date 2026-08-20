import { describe, expect, it } from "vitest";

import type { MemoryRepository } from "../src/memory/memory-repository.js";
import { MemoryService } from "../src/memory/memory-service.js";

describe("memory service errors", () => {
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
