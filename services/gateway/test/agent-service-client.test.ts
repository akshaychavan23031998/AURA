import { describe, expect, it, vi } from "vitest";

import { createAgentServiceClient } from "../src/clients/agent/agent-service-client.js";
import { testConfig } from "./test-config.js";

const validBody = {
  requestId: "request-1",
  intent: "propose_tool",
  response: "I can propose the echo tool for that request.",
  plan: {
    type: "tool",
    tool: { name: "system.echo", input: { message: "hello" } },
  },
};

describe("Agent Service client", () => {
  it("authenticates, propagates correlation, and validates the result", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(validBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const result = await createAgentServiceClient(
      testConfig,
      fetchMock,
    ).respond({ message: "echo hello" }, "request-1");
    expect(result.plan.type).toBe("tool");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-request-id": "request-1",
      "x-aura-service-id": "gateway",
      "x-aura-service-token": testConfig.agentService.token,
    });
  });

  it.each([
    new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify({ ...validBody, requestId: "wrong" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify({ ...validBody, plan: { type: "execute" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ])("fails closed for malformed upstream responses", async (response) => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response));
    await expect(
      createAgentServiceClient(testConfig, fetchMock).respond(
        { message: "hello" },
        "request-1",
      ),
    ).rejects.toMatchObject({
      code: "UPSTREAM_PROTOCOL_ERROR",
      httpStatus: 502,
    });
  });

  it("maps unavailability and timeouts", async () => {
    const unavailable = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError("refused")),
    );
    await expect(
      createAgentServiceClient(testConfig, unavailable).respond(
        { message: "hello" },
        "request-1",
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_SERVICE_UNAVAILABLE" });

    const timeout = vi.fn<typeof fetch>(() =>
      Promise.reject(new DOMException("timed out", "TimeoutError")),
    );
    await expect(
      createAgentServiceClient(testConfig, timeout).respond(
        { message: "hello" },
        "request-1",
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_SERVICE_TIMEOUT" });
  });

  it("accepts strict memory plans and forwards sanitized continuation context", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          requestId: "request-memory",
          intent: "memory",
          response: "",
          plan: { type: "memory_read", kind: "preference" },
        }),
      ),
    );
    const client = createAgentServiceClient(testConfig, fetchMock);
    await expect(
      client.respond({ message: "what do you remember?" }, "request-memory"),
    ).resolves.toMatchObject({ plan: { type: "memory_read" } });
    await client.respond(
      {
        message: "what do you remember?",
        memoryContext: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            kind: "preference",
            content: "Prefers concise answers",
          },
        ],
      },
      "request-memory",
    );
    const sentBody = fetchMock.mock.calls[1]?.[1]?.body;
    expect(typeof sentBody).toBe("string");
    const body = JSON.parse(sentBody as string) as Record<string, unknown>;
    expect(body["memoryContext"]).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000010",
        kind: "preference",
        content: "Prefers concise answers",
      },
    ]);
    expect(body).not.toHaveProperty("actorId");
    expect(body).not.toHaveProperty("permissions");
  });

  it("accepts strict knowledge search and forwards only bounded evidence context", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          requestId: "request-knowledge",
          intent: "propose_knowledge_search",
          response: "I can search saved knowledge.",
          plan: { type: "knowledge_search", query: "deployment" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          requestId: "request-knowledge",
          intent: "respond",
          response: "Use the documented process. [K1]",
          plan: { type: "respond" },
          citationIds: ["K1"],
        }),
      );
    const client = createAgentServiceClient(testConfig, fetchMock);
    await expect(
      client.respond({ message: "saved deployment" }, "request-knowledge"),
    ).resolves.toMatchObject({ plan: { type: "knowledge_search" } });
    await expect(
      client.respond(
        {
          message: "saved deployment",
          knowledgeContext: [
            {
              reference: "K1",
              title: "Deployment",
              content: "Use the documented process.",
              ordinal: 0,
            },
          ],
        },
        "request-knowledge",
      ),
    ).resolves.toMatchObject({ citationIds: ["K1"] });
    const body = JSON.parse(
      fetchMock.mock.calls[1]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(body["knowledgeContext"]).toEqual([
      {
        reference: "K1",
        title: "Deployment",
        content: "Use the documented process.",
        ordinal: 0,
      },
    ]);
    expect(body).not.toHaveProperty("actorId");
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("similarity");
  });

  it.each([
    { type: "knowledge_search", query: "deployment", actorId: "attacker" },
    { type: "knowledge_search", query: "deployment", limit: 10 },
    { type: "knowledge_search", query: "deployment\u0000" },
    { type: "knowledge_search", query: "x".repeat(1025) },
  ])("rejects unsafe knowledge plans from the Agent", async (plan) => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          requestId: "request-1",
          intent: "knowledge",
          response: "",
          plan,
        }),
      ),
    );
    await expect(
      createAgentServiceClient(testConfig, fetchMock).respond(
        { message: "hello" },
        "request-1",
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_PROTOCOL_ERROR" });
  });

  it.each([
    { type: "memory_create", kind: "unknown", content: "x" },
    { type: "memory_create", kind: "note", content: "x", actorId: "attacker" },
    { type: "memory_delete", memoryId: "not-a-uuid" },
    { type: "memory_search", query: "timezone", actorId: "attacker" },
  ])("rejects unsafe memory plans from the Agent", async (plan) => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          requestId: "request-1",
          intent: "memory",
          response: "",
          plan,
        }),
      ),
    );
    await expect(
      createAgentServiceClient(testConfig, fetchMock).respond(
        { message: "hello" },
        "request-1",
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_PROTOCOL_ERROR" });
  });

  it("composes caller cancellation with the configured timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("superseded", "AbortError")),
            { once: true },
          ),
        ),
    );
    const controller = new AbortController();
    const request = createAgentServiceClient(testConfig, fetchMock).respond(
      { message: "hello" },
      "request-cancel",
      controller.signal,
    );
    controller.abort(new DOMException("superseded", "AbortError"));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
