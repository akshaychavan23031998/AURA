import { describe, expect, it, vi } from "vitest";

import { ToolExecutor } from "../src/execution/tool-executor.js";
import { createGoogleGmailClient } from "../src/providers/google-gmail-client.js";
import { ToolRegistry } from "../src/registry/tool-registry.js";
import { createGmailTools } from "../src/tools/gmail/messages.tool.js";

const context = {
  requestId: "gmail-request-1",
  actorId: "actor-1",
  grantedPermissions: ["gmail.messages.read"],
  providerAccessToken: "short-lived-provider-token",
};

describe("Google Gmail read tools", () => {
  it("defines exactly two read-only, approval-free Gmail capabilities", () => {
    const registry = gmailRegistry(createGoogleGmailClient());
    expect(registry.listMetadata()).toEqual([
      expect.objectContaining({
        name: "gmail.messages.get",
        category: "communication",
        riskLevel: "READ",
        approvalPolicy: "NONE",
        idempotency: "IDEMPOTENT",
        requiredPermissions: ["gmail.messages.read"],
      }),
      expect.objectContaining({
        name: "gmail.messages.list",
        category: "communication",
        riskLevel: "READ",
        approvalPolicy: "NONE",
        idempotency: "IDEMPOTENT",
        requiredPermissions: ["gmail.messages.read"],
      }),
    ]);
    expect(
      registry
        .listMetadata()
        .some((tool) => /send|modify|delete/.test(tool.name)),
    ).toBe(false);
  });

  it("lists bounded normalized metadata through fixed user-me endpoints", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      if (!(input instanceof URL)) throw new Error("Expected fixed URL");
      const url = input;
      if (url.pathname === "/gmail/v1/users/me/messages")
        return Promise.resolve(
          Response.json({ messages: [{ id: "message-1" }] }),
        );
      return Promise.resolve(Response.json(providerMessage("message-1")));
    });
    const result = await createGoogleGmailClient(fetcher).list(
      "provider-secret",
      { maxResults: 10, query: "interview" },
      "request-1",
    );
    expect(result).toEqual([
      {
        id: "message-1",
        threadId: "thread-1",
        from: "sender@example.com",
        to: "me@example.com",
        cc: "reviewer@example.com",
        subject: "Interview",
        date: "Fri, 14 Aug 2026 10:00:00 +0000",
        snippet: "Bounded preview",
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls) {
      const url = call[0];
      expect(url).toBeInstanceOf(URL);
      expect(url instanceof URL ? url.origin : "").toBe(
        "https://gmail.googleapis.com",
      );
      expect(url instanceof URL ? url.pathname : "").toContain("/users/me/");
      expect(url instanceof URL ? url.href : "").not.toContain(
        "provider-secret",
      );
      expect(call[1]?.headers).toMatchObject({ "x-request-id": "request-1" });
    }
  });

  it("gets only metadata and a snippet for an encoded message ID", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(providerMessage("message-1")));
    await createGoogleGmailClient(fetcher).get(
      "provider-token",
      "message-1",
      "request-get-1",
    );
    const url = fetcher.mock.calls[0]?.[0];
    expect(url).toBeInstanceOf(URL);
    if (!(url instanceof URL)) throw new Error("Expected URL");
    expect(url.href).toMatch(
      /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/message-1/,
    );
    expect(url.searchParams.get("format")).toBe("metadata");
    expect(url.searchParams.getAll("metadataHeaders")).toEqual([
      "From",
      "To",
      "Cc",
      "Subject",
      "Date",
    ]);
  });

  it("enforces strict inputs, exact permission, and provider credentials", async () => {
    const client = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(normalizedMessage()),
    };
    const executor = new ToolExecutor(gmailRegistry(client));
    await expect(
      executor.execute({
        tool: "gmail.messages.list",
        input: { maxResults: 10 },
        context,
      }),
    ).resolves.toMatchObject({ status: "success" });
    for (const input of [
      { maxResults: 21 },
      { maxResults: 10, query: "x".repeat(201) },
      { maxResults: 10, query: "from:someone@example.com" },
      { maxResults: 10, userId: "victim@example.com" },
    ])
      await expect(
        executor.execute({
          tool: "gmail.messages.list",
          input,
          context,
        }),
      ).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });
    for (const input of [
      { messageId: "" },
      { messageId: "../other" },
      { messageId: "message-1", providerAccessToken: "injected" },
    ])
      await expect(
        executor.execute({
          tool: "gmail.messages.get",
          input,
          context,
        }),
      ).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });
    await expect(
      executor.execute({
        tool: "gmail.messages.get",
        input: { messageId: "message-1" },
        context: { ...context, grantedPermissions: ["calendar.events.read"] },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      executor.execute({
        tool: "gmail.messages.get",
        input: { messageId: "message-1" },
        context: {
          requestId: context.requestId,
          actorId: context.actorId,
          grantedPermissions: context.grantedPermissions,
        },
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_REAUTH_REQUIRED" });
  });

  it.each([
    [401, "PROVIDER_REAUTH_REQUIRED"],
    [403, "PROVIDER_REAUTH_REQUIRED"],
    [429, "GMAIL_RATE_LIMITED"],
    [500, "GMAIL_REQUEST_FAILED"],
  ])("sanitizes provider status %i as %s", async (status, code) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private provider failure", { status }));
    await expect(
      createGoogleGmailClient(fetcher).get(
        "provider-token",
        "message-1",
        "request-1",
      ),
    ).rejects.toMatchObject({ code });
  });
});

function gmailRegistry(client: Parameters<typeof createGmailTools>[0]) {
  const registry = new ToolRegistry();
  for (const tool of createGmailTools(client)) registry.register(tool);
  registry.seal();
  return registry;
}

function providerMessage(id: string) {
  return {
    id,
    threadId: "thread-1",
    snippet: "Bounded preview",
    payload: {
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "me@example.com" },
        { name: "Cc", value: "reviewer@example.com" },
        { name: "Subject", value: "Interview" },
        { name: "Date", value: "Fri, 14 Aug 2026 10:00:00 +0000" },
      ],
    },
    raw: "must not escape",
  };
}

function normalizedMessage() {
  return {
    id: "message-1",
    threadId: "thread-1",
    from: "sender@example.com",
    to: "me@example.com",
    subject: "Interview",
    date: "Fri, 14 Aug 2026 10:00:00 +0000",
    snippet: "Bounded preview",
  };
}
