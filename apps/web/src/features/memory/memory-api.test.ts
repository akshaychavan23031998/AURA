import { describe, expect, it, vi } from "vitest";

import { MemoryApi } from "./memory-api";

const memory = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "preference",
  content: "Prefer concise answers",
  source: "user_explicit",
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};

describe("MemoryApi", () => {
  it("submits only kind and content and uses the server-issued ID for delete", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ memory }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new MemoryApi({ request }, new URL("http://gateway.test/"));
    await api.create({ kind: "preference", content: "Prefer concise answers" });
    const createInit = request.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(createInit.body as string)).toEqual({
      kind: "preference",
      content: "Prefer concise answers",
    });
    expect(createInit.body).not.toMatch(/actor|source|status/i);

    await api.delete(memory.id);
    expect(String(request.mock.calls[1]?.[0])).toBe(
      `http://gateway.test/api/v1/memories/${memory.id}`,
    );
    expect(request.mock.calls[1]?.[1]).toEqual({ method: "DELETE" });
  });
});
