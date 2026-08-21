import { describe, expect, it, vi } from "vitest";

import {
  createMemoryEmbeddingClient,
  validateEmbedding,
} from "../src/memory/memory-embedding-client.js";

const config = {
  baseUrl: "http://127.0.0.1:8081",
  model: "test-embedding",
  dimensions: 3,
  timeoutMs: 1000,
};

describe("memory embedding client", () => {
  it("uses one fixed endpoint/model and propagates request correlation", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ data: [{ embedding: [1, 0, 0] }] })),
    );
    await expect(
      createMemoryEmbeddingClient(config, fetchMock).embed(
        "private text",
        "r-1",
      ),
    ).resolves.toEqual([1, 0, 0]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8081/v1/embeddings",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-request-id"),
    ).toBe("r-1");
  });

  it.each([[[1, 2]], [[1, Number.NaN, 3]], [[1, Number.POSITIVE_INFINITY, 3]]])(
    "rejects malformed vectors",
    (embedding) => {
      expect(() => validateEmbedding(embedding, 3)).toThrowError(
        expect.objectContaining({ code: "MEMORY_EMBEDDING_UNAVAILABLE" }),
      );
    },
  );

  it("sanitizes upstream failures", async () => {
    const client = createMemoryEmbeddingClient(
      config,
      vi.fn(() =>
        Promise.resolve(
          new Response("private provider error", { status: 500 }),
        ),
      ),
    );
    await expect(client.embed("private query", "r-2")).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_UNAVAILABLE",
      message: "Memory embedding service is unavailable",
    });
  });

  it("stops reading a chunked response once the body bound is exceeded", async () => {
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(70_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = createMemoryEmbeddingClient(
      config,
      vi.fn(() => Promise.resolve(new Response(oversized, { status: 200 }))),
    );

    await expect(
      client.embed("private query", "r-bounded"),
    ).rejects.toMatchObject({ code: "MEMORY_EMBEDDING_UNAVAILABLE" });
    expect(cancelled).toBe(true);
  });
});
