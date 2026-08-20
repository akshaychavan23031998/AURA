import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app/create-app.js";
import type { AllowedPermission } from "../src/auth/principal.js";
import type { AccessTokenVerifier } from "../src/auth/token-verifier.js";
import type { ErrorResponse } from "../src/errors/error-response.js";
import type { MemoryStore, MemoryView } from "../src/memory/memory-service.js";
import { testConfig } from "./test-config.js";

const authorization = { authorization: "Bearer test.header.signature" };
const id = "00000000-0000-4000-8000-000000000010";
const memory: MemoryView = {
  id,
  kind: "preference",
  content: "Prefer concise answers",
  source: "user_explicit",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

function verifier(
  permissions: readonly AllowedPermission[],
): AccessTokenVerifier {
  return {
    verify: () =>
      Promise.resolve({
        actorId: "00000000-0000-4000-8000-000000000001",
        sessionId: "00000000-0000-4000-8000-000000000002",
        permissions,
        tokenIssuedAt: 1,
        tokenExpiresAt: 2,
      }),
  };
}

function store(): MemoryStore {
  return {
    create: vi.fn(() => Promise.resolve(memory)),
    getOwned: vi.fn(() => Promise.resolve(memory)),
    listOwned: vi.fn(() => Promise.resolve([memory])),
    deleteOwned: vi.fn(() => Promise.resolve()),
  };
}

describe("memory routes", () => {
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  async function app(
    permissions: readonly AllowedPermission[],
    memories = store(),
  ) {
    const instance = await createApp({
      config: testConfig,
      logger: false,
      tokenVerifier: verifier(permissions),
      memoryService: memories,
    });
    apps.push(instance);
    return { instance, memories };
  }

  it("requires authentication for reads and writes", async () => {
    const { instance } = await app(["memory.read", "memory.write"]);
    for (const request of [
      { method: "GET" as const, url: "/api/v1/memories" },
      {
        method: "POST" as const,
        url: "/api/v1/memories",
        payload: { kind: "note", content: "x" },
      },
    ]) {
      const response = await instance.inject(request);
      expect(response.statusCode).toBe(401);
    }
  });

  it("keeps read and write permissions independent", async () => {
    const reader = await app(["memory.read"]);
    expect(
      (
        await reader.instance.inject({
          method: "GET",
          url: "/api/v1/memories",
          headers: authorization,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await reader.instance.inject({
          method: "POST",
          url: "/api/v1/memories",
          headers: authorization,
          payload: { kind: "note", content: "x" },
        })
      ).statusCode,
    ).toBe(403);
    const writer = await app(["memory.write"]);
    expect(
      (
        await writer.instance.inject({
          method: "GET",
          url: "/api/v1/memories",
          headers: authorization,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("derives actor and source while rejecting ownership injection", async () => {
    const { instance, memories } = await app(["memory.write"]);
    const rejected = await instance.inject({
      method: "POST",
      url: "/api/v1/memories",
      headers: authorization,
      payload: { kind: "preference", content: "safe", actorId: "attacker" },
    });
    expect(rejected.statusCode).toBe(400);
    expect(memories.create as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

    const accepted = await instance.inject({
      method: "POST",
      url: "/api/v1/memories",
      headers: authorization,
      payload: { kind: "preference", content: "Prefer concise answers" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(memories.create).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      { kind: "preference", content: "Prefer concise answers" },
    );
    expect(accepted.json()).toEqual({ memory });
    expect(JSON.stringify(accepted.json())).not.toContain("actorId");
  });

  it.each([
    [{ kind: "unknown", content: "x" }],
    [{ kind: "note", content: "   " }],
    [{ kind: "note", content: "x".repeat(4097) }],
    [{ kind: "note", content: "unsafe\u0000content" }],
    [{ kind: "note", content: "x", source: "system" }],
    [{ kind: "note", content: "x", status: "ACTIVE" }],
  ])("rejects invalid or caller-controlled create input", async (payload) => {
    const { instance } = await app(["memory.write"]);
    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/memories",
      headers: authorization,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe(
      "MEMORY_INPUT_INVALID",
    );
  });

  it("bounds list queries and supports a strict kind filter", async () => {
    const { instance, memories } = await app(["memory.read"]);
    expect(
      (
        await instance.inject({
          method: "GET",
          url: "/api/v1/memories?limit=51",
          headers: authorization,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await instance.inject({
          method: "GET",
          url: "/api/v1/memories?unknown=x",
          headers: authorization,
        })
      ).statusCode,
    ).toBe(400);
    const response = await instance.inject({
      method: "GET",
      url: "/api/v1/memories?limit=5&kind=preference",
      headers: authorization,
    });
    expect(response.statusCode).toBe(200);
    expect(memories.listOwned).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      { limit: 5, kind: "preference" },
    );
  });

  it("validates identifiers and performs owner-scoped get and delete", async () => {
    const { instance, memories } = await app(["memory.read", "memory.write"]);
    expect(
      (
        await instance.inject({
          method: "GET",
          url: "/api/v1/memories/not-a-uuid",
          headers: authorization,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await instance.inject({
          method: "GET",
          url: `/api/v1/memories/${id}`,
          headers: authorization,
        })
      ).statusCode,
    ).toBe(200);
    const deleted = await instance.inject({
      method: "DELETE",
      url: `/api/v1/memories/${id}`,
      headers: authorization,
    });
    expect(deleted.statusCode).toBe(204);
    expect(memories.getOwned).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      id,
    );
    expect(memories.deleteOwned).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      id,
    );
  });

  it("does not emit memory content in structured request logs", async () => {
    const privateContent = "private-memory-content-must-not-be-logged";
    let logs = "";
    const instance = await createApp({
      config: testConfig,
      logger: {
        level: "info",
        stream: {
          write: (message: string) => {
            logs += message;
          },
        },
      },
      tokenVerifier: verifier(["memory.write"]),
      memoryService: {
        ...store(),
        create: () => Promise.resolve({ ...memory, content: privateContent }),
      },
    });
    apps.push(instance);
    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/memories",
      headers: authorization,
      payload: { kind: "note", content: privateContent },
    });
    expect(response.statusCode).toBe(200);
    expect(logs).not.toContain(privateContent);
  });
});
