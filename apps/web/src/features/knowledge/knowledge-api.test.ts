import { describe, expect, it, vi } from "vitest";

import { KnowledgeApi } from "./knowledge-api";

const metadata = {
  id: "00000000-0000-4000-8000-000000000010",
  title: "Architecture",
  sourceType: "manual_text",
  chunkCount: 2,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};

describe("KnowledgeApi", () => {
  it("sends only manual text fields and only the semantic query", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ document: metadata }))
      .mockResolvedValueOnce(Response.json({ results: [] }));
    const api = new KnowledgeApi({ request }, new URL("http://gateway.test/"));
    await api.create({ title: "Architecture", content: "Trusted boundary" });
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).toEqual({
      title: "Architecture",
      content: "Trusted boundary",
    });
    expect(request.mock.calls[0]?.[1]?.body).not.toMatch(
      /actor|chunk|hash|vector|model/i,
    );

    await api.search("deployment procedure");
    expect(JSON.parse(request.mock.calls[1]?.[1]?.body as string)).toEqual({
      query: "deployment procedure",
    });
    expect(request.mock.calls[1]?.[1]?.body).not.toMatch(
      /actor|limit|threshold|vector|model/i,
    );
  });

  it("uploads exactly one file without client authority fields or a manual boundary", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        document: { ...metadata, sourceType: "file_txt" },
      }),
    );
    const api = new KnowledgeApi({ request }, new URL("http://gateway.test/"));
    const file = new File(["private text"], "notes.txt", {
      type: "text/plain",
    });
    await api.upload(file);
    const init = request.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    const entries = Array.from((init.body as FormData).entries());
    expect(entries).toEqual([["file", file]]);
    expect(entries.map(([key]) => key)).not.toEqual(
      expect.arrayContaining(["actorId", "sourceType", "model", "vector"]),
    );
  });
});
