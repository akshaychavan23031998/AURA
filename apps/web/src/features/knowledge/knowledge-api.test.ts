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
});
