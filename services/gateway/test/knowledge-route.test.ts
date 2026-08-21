import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app/create-app.js";
import type { AllowedPermission } from "../src/auth/principal.js";
import type { AccessTokenVerifier } from "../src/auth/token-verifier.js";
import type { ErrorResponse } from "../src/errors/error-response.js";
import type {
  KnowledgeDocumentMetadataView,
  KnowledgeDocumentView,
  KnowledgeSearchResultView,
  KnowledgeStore,
} from "../src/knowledge/knowledge-service.js";
import { testConfig } from "./test-config.js";

const authorization = { authorization: "Bearer test.header.signature" };
const actorId = "00000000-0000-4000-8000-000000000001";
const documentId = "00000000-0000-4000-8000-000000000010";
const metadata: KnowledgeDocumentMetadataView = {
  id: documentId,
  title: "Architecture",
  sourceType: "manual_text",
  chunkCount: 2,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};
const document: KnowledgeDocumentView = {
  ...metadata,
  content: "Private content",
};
const searchResult: KnowledgeSearchResultView = {
  documentId,
  chunkId: "00000000-0000-4000-8000-000000000011",
  title: "Architecture",
  content: "Deployment uses a private container network.",
  ordinal: 2,
};

function verifier(
  permissions: readonly AllowedPermission[],
): AccessTokenVerifier {
  return {
    verify: () =>
      Promise.resolve({
        actorId,
        sessionId: "00000000-0000-4000-8000-000000000002",
        permissions,
        tokenIssuedAt: 1,
        tokenExpiresAt: 2,
      }),
  };
}

function store(): KnowledgeStore {
  return {
    create: vi.fn(() => Promise.resolve(metadata)),
    listOwned: vi.fn(() => Promise.resolve([metadata])),
    getOwned: vi.fn(() => Promise.resolve(document)),
    deleteOwned: vi.fn(() => Promise.resolve()),
    searchOwned: vi.fn(() => Promise.resolve([searchResult])),
  };
}

describe("knowledge routes", () => {
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  async function app(
    permissions: readonly AllowedPermission[],
    knowledge = store(),
  ) {
    const instance = await createApp({
      config: testConfig,
      logger: false,
      tokenVerifier: verifier(permissions),
      knowledgeService: knowledge,
    });
    apps.push(instance);
    return { instance, knowledge };
  }

  it("requires authentication for all document operations", async () => {
    const { instance } = await app(["knowledge.read", "knowledge.write"]);
    for (const request of [
      { method: "GET" as const, url: "/api/v1/knowledge/documents" },
      {
        method: "GET" as const,
        url: `/api/v1/knowledge/documents/${documentId}`,
      },
      {
        method: "POST" as const,
        url: "/api/v1/knowledge/documents",
        payload: { title: "x", content: "x" },
      },
      {
        method: "DELETE" as const,
        url: `/api/v1/knowledge/documents/${documentId}`,
      },
      {
        method: "POST" as const,
        url: "/api/v1/knowledge/search",
        payload: { query: "deployment" },
      },
      {
        method: "POST" as const,
        url: "/api/v1/knowledge/files",
        ...multipartFile("file", "notes.txt", "text/plain", Buffer.from("x")),
      },
    ])
      expect((await instance.inject(request)).statusCode).toBe(401);
  });

  it("does not expose embedding or vector routes", async () => {
    const { instance } = await app(["knowledge.read", "knowledge.write"]);
    for (const request of [
      { method: "GET" as const, url: "/api/v1/knowledge/embeddings" },
      { method: "GET" as const, url: "/api/v1/knowledge/vectors" },
    ]) {
      const response = await instance.inject({
        ...request,
        headers: authorization,
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it("keeps read and write permissions independent", async () => {
    const reader = await app(["knowledge.read"]);
    expect(
      (
        await reader.instance.inject({
          method: "GET",
          url: "/api/v1/knowledge/documents",
          headers: authorization,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await reader.instance.inject({
          method: "POST",
          url: "/api/v1/knowledge/documents",
          headers: authorization,
          payload: { title: "x", content: "x" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await reader.instance.inject({
          method: "POST",
          url: "/api/v1/knowledge/files",
          headers: {
            ...authorization,
            ...multipartFile(
              "file",
              "notes.txt",
              "text/plain",
              Buffer.from("x"),
            ).headers,
          },
          payload: multipartFile(
            "file",
            "notes.txt",
            "text/plain",
            Buffer.from("x"),
          ).payload,
        })
      ).statusCode,
    ).toBe(403);
    const writer = await app(["knowledge.write"]);
    expect(
      (
        await writer.instance.inject({
          method: "GET",
          url: "/api/v1/knowledge/documents",
          headers: authorization,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await writer.instance.inject({
          method: "POST",
          url: "/api/v1/knowledge/search",
          headers: authorization,
          payload: { query: "deployment" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("ingests exactly one authenticated TXT file through the existing service", async () => {
    const { instance, knowledge } = await app(["knowledge.write"]);
    const upload = multipartFile(
      "file",
      "C:\\fakepath\\architecture.txt",
      "text/plain",
      Buffer.from("Gateway\r\nowns persistence."),
    );
    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/knowledge/files",
      headers: { ...authorization, ...upload.headers },
      payload: upload.payload,
    });
    expect(response.statusCode).toBe(201);
    expect(knowledge.create).toHaveBeenCalledWith(
      actorId,
      {
        title: "architecture",
        sourceType: "file_txt",
        content: "Gateway\r\nowns persistence.",
      },
      expect.any(String),
    );
  });

  it.each([
    ["extra", "notes.txt", "text/plain", Buffer.from("x")],
    ["file", "notes.exe", "application/octet-stream", Buffer.from("MZ")],
    ["file", "notes.txt", "application/pdf", Buffer.from("plain")],
    ["file", "fake.pdf", "application/pdf", Buffer.from("plain")],
  ])(
    "rejects malformed, unsupported, or mismatched file uploads",
    async (field, filename, mime, bytes) => {
      const { instance, knowledge } = await app(["knowledge.write"]);
      const upload = multipartFile(field, filename, mime, bytes);
      const response = await instance.inject({
        method: "POST",
        url: "/api/v1/knowledge/files",
        headers: { ...authorization, ...upload.headers },
        payload: upload.payload,
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(knowledge.create).not.toHaveBeenCalled();
      expect(response.body).not.toContain("plain");
    },
  );

  it("derives search ownership and returns only sanitized chunks", async () => {
    const { instance, knowledge } = await app(["knowledge.read"]);
    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/knowledge/search",
      headers: authorization,
      payload: { query: "  deployment procedure  " },
    });
    expect(response.statusCode).toBe(200);
    expect(knowledge.searchOwned).toHaveBeenCalledWith(
      actorId,
      "deployment procedure",
      expect.any(String),
    );
    const body = response.json<{ results: KnowledgeSearchResultView[] }>();
    expect(body).toEqual({ results: [searchResult] });
    expect(body.results[0]).not.toHaveProperty("actorId");
    expect(body.results[0]).not.toHaveProperty("embedding");
    expect(body.results[0]).not.toHaveProperty("model");
    expect(body.results[0]).not.toHaveProperty("similarity");
    expect(body.results[0]).not.toHaveProperty("contentHash");
  });

  it.each([
    {},
    { query: "" },
    { query: " ".repeat(10) },
    { query: "x".repeat(1025) },
    { query: "unsafe\0query" },
    { query: "unsafe\u0001query" },
    { query: "x", actorId: "attacker" },
    { query: "x", userId: "attacker" },
    { query: "x", ownerId: "attacker" },
    { query: "x", vector: [1, 2, 3] },
    { query: "x", model: "attacker-model" },
    { query: "x", threshold: -1 },
    { query: "x", status: "DELETED" },
    { query: "x", limit: 10 },
  ])("rejects invalid or caller-controlled search input", async (payload) => {
    const { instance, knowledge } = await app(["knowledge.read"]);
    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/knowledge/search",
      headers: authorization,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe(
      "KNOWLEDGE_INPUT_INVALID",
    );
    expect(knowledge.searchOwned).not.toHaveBeenCalled();
  });

  it("derives ownership and returns only safe create metadata", async () => {
    const { instance, knowledge } = await app(["knowledge.write"]);
    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/knowledge/documents",
      headers: authorization,
      payload: { title: "Architecture", content: "Private content" },
    });
    expect(response.statusCode).toBe(201);
    expect(knowledge.create).toHaveBeenCalledWith(
      actorId,
      { title: "Architecture", content: "Private content" },
      expect.any(String),
    );
    const body = response.json<{ document: KnowledgeDocumentMetadataView }>();
    expect(body).toEqual({ document: metadata });
    expect(body.document).not.toHaveProperty("actorId");
    expect(body.document).not.toHaveProperty("contentHash");
    expect(body.document).not.toHaveProperty("status");
  });

  it("accepts JSON escaping overhead without weakening the content bound", async () => {
    const { instance, knowledge } = await app(["knowledge.write"]);
    const content = '"'.repeat(131_072);
    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/knowledge/documents",
      headers: authorization,
      payload: { title: "Boundary", content },
    });
    expect(response.statusCode).toBe(201);
    expect(knowledge.create).toHaveBeenCalledWith(
      actorId,
      { title: "Boundary", content },
      expect.any(String),
    );
  });

  it.each([
    { title: "", content: "x" },
    { title: "x".repeat(201), content: "x" },
    { title: "unsafe\nname", content: "x" },
    { title: "x", content: "" },
    { title: "x", content: "x".repeat(131_073) },
    { title: "x", content: "unsafe\0content" },
    { title: "x", content: "x", actorId: "attacker" },
    { title: "x", content: "x", userId: "attacker" },
    { title: "x", content: "x", ownerId: "attacker" },
    { title: "x", content: "x", sourceType: "manual_text" },
    { title: "x", content: "x", status: "ACTIVE" },
    { title: "x", content: "x", contentHash: "injected" },
    { title: "x", content: "x", chunkCount: 1 },
    { title: "x", content: "x", model: "attacker-model" },
    { title: "x", content: "x", embedding: [1, 2, 3] },
  ])("rejects invalid or caller-controlled create input", async (payload) => {
    const { instance, knowledge } = await app(["knowledge.write"]);
    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/knowledge/documents",
      headers: authorization,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe(
      "KNOWLEDGE_INPUT_INVALID",
    );
    expect(knowledge.create).not.toHaveBeenCalled();
  });

  it("bounds list input and excludes content from list responses", async () => {
    const { instance, knowledge } = await app(["knowledge.read"]);
    for (const query of ["?limit=51", "?unknown=x"])
      expect(
        (
          await instance.inject({
            method: "GET",
            url: `/api/v1/knowledge/documents${query}`,
            headers: authorization,
          })
        ).statusCode,
      ).toBe(400);
    const response = await instance.inject({
      method: "GET",
      url: "/api/v1/knowledge/documents?limit=5",
      headers: authorization,
    });
    expect(response.statusCode).toBe(200);
    expect(knowledge.listOwned).toHaveBeenCalledWith(actorId, 5);
    expect(
      response.json<{ documents: KnowledgeDocumentMetadataView[] }>()
        .documents[0],
    ).not.toHaveProperty("content");
  });

  it("validates IDs and scopes get/delete to the authenticated actor", async () => {
    const { instance, knowledge } = await app([
      "knowledge.read",
      "knowledge.write",
    ]);
    expect(
      (
        await instance.inject({
          method: "GET",
          url: "/api/v1/knowledge/documents/not-a-uuid",
          headers: authorization,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await instance.inject({
          method: "GET",
          url: `/api/v1/knowledge/documents/${documentId}`,
          headers: authorization,
        })
      ).json(),
    ).toEqual({ document });
    expect(
      (
        await instance.inject({
          method: "DELETE",
          url: `/api/v1/knowledge/documents/${documentId}`,
          headers: authorization,
        })
      ).statusCode,
    ).toBe(204);
    expect(knowledge.getOwned).toHaveBeenCalledWith(actorId, documentId);
    expect(knowledge.deleteOwned).toHaveBeenCalledWith(
      actorId,
      documentId,
      expect.any(String),
    );
  });

  it("does not log raw document content", async () => {
    let logs = "";
    const instance = await createApp({
      config: testConfig,
      logger: { stream: { write: (message: string) => (logs += message) } },
      tokenVerifier: verifier(["knowledge.write"]),
      knowledgeService: store(),
    });
    apps.push(instance);
    const secret = "private-document-content-must-not-be-logged";
    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/knowledge/documents",
      headers: authorization,
      payload: { title: "Private title", content: secret },
    });
    expect(response.statusCode).toBe(201);
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain("Private title");

    const uploadSecret = "uploaded-secret-must-never-enter-logs";
    const upload = multipartFile(
      "file",
      "secret.txt",
      "text/plain",
      Buffer.from(uploadSecret),
    );
    expect(
      (
        await instance.inject({
          method: "POST",
          url: "/api/v1/knowledge/files",
          headers: { ...authorization, ...upload.headers },
          payload: upload.payload,
        })
      ).statusCode,
    ).toBe(201);
    expect(logs).not.toContain(uploadSecret);
    expect(logs).not.toContain("secret.txt");
  });
});

function multipartFile(
  field: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
) {
  const boundary = "aura-knowledge-boundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([head, bytes, tail]),
  };
}
