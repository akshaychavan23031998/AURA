import { describe, expect, it, vi } from "vitest";

import { ToolExecutor } from "../src/execution/tool-executor.js";
import { actionDigest } from "../src/execution/action-digest.js";
import {
  buildMimeMessage,
  createGoogleGmailClient,
} from "../src/providers/google-gmail-client.js";
import { ToolRegistry } from "../src/registry/tool-registry.js";
import { createGmailTools } from "../src/tools/gmail/messages.tool.js";

const context = {
  requestId: "gmail-request-1",
  actorId: "actor-1",
  grantedPermissions: ["gmail.messages.read"],
  providerAccessToken: "short-lived-provider-token",
};

describe("Google Gmail tools", () => {
  it("defines exactly two read and two approved write capabilities", () => {
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
      expect.objectContaining({
        name: "gmail.messages.reply",
        riskLevel: "WRITE",
        approvalPolicy: "REQUIRED",
        idempotency: "NON_IDEMPOTENT",
        requiredPermissions: ["gmail.messages.send"],
      }),
      expect.objectContaining({
        name: "gmail.messages.send",
        riskLevel: "WRITE",
        approvalPolicy: "REQUIRED",
        idempotency: "NON_IDEMPOTENT",
        requiredPermissions: ["gmail.messages.send"],
      }),
    ]);
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
      "Reply-To",
      "To",
      "Cc",
      "Subject",
      "Date",
      "Message-ID",
      "References",
    ]);
  });

  it("enforces strict inputs, exact permission, and provider credentials", async () => {
    const client = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(normalizedMessage()),
      send: vi.fn(),
      reply: vi.fn(),
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

  it("constructs deterministic, injection-safe UTF-8 MIME", () => {
    const mime = buildMimeMessage(
      "alice@example.com",
      "नमस्ते update",
      "Hello\nHaan, deployment complete.",
    );
    expect(mime).toBe(
      "To: alice@example.com\r\nSubject: =?UTF-8?B?4KSo4KSu4KS44KWN4KSk4KWHIHVwZGF0ZQ==?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nHello\r\nHaan, deployment complete.",
    );
    expect(() =>
      buildMimeMessage(
        "alice@example.com\r\nBcc: victim@example.com",
        "Safe",
        "x",
      ),
    ).toThrow("Unsafe email header value");
    expect(() =>
      buildMimeMessage("alice@example.com", "Safe\r\nBcc: x@example.com", "x"),
    ).toThrow("Unsafe email header value");
  });

  it("prepares send without mutation and sends exactly once after trusted approval", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "sent-1", threadId: "thread-1" }));
    const executor = new ToolExecutor(
      gmailRegistry(createGoogleGmailClient(fetcher)),
    );
    const input = {
      to: "alice@example.com",
      subject: "Project update",
      body: "Deployment is complete",
    };
    const preparation = executor.prepare("gmail.messages.send", 1, input, {
      actorId: "actor-1",
      grantedPermissions: ["gmail.messages.send"],
    });
    expect(preparation).toMatchObject({ approvalPolicy: "REQUIRED", input });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      executor.execute({
        tool: "gmail.messages.send",
        input,
        context: {
          ...context,
          grantedPermissions: ["gmail.messages.send"],
          approval: approval(input, "gmail.messages.send"),
        },
      }),
    ).resolves.toMatchObject({
      data: { messageId: "sent-1", threadId: "thread-1", sent: true },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBeInstanceOf(URL);
    expect(url instanceof URL ? url.href : "").toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    );
    expect(init?.method).toBe("POST");
    const requestBody = init?.body;
    if (typeof requestBody !== "string") throw new Error("Expected JSON body");
    const payload = JSON.parse(requestBody) as { raw: string };
    expect(Object.keys(payload)).toEqual(["raw"]);
    expect(Buffer.from(payload.raw, "base64url").toString("utf8")).toContain(
      "To: alice@example.com\r\nSubject: Project update",
    );
  });

  it("derives reply recipient, thread, and headers from provider metadata", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ...providerMessage("original-1"),
          payload: {
            headers: [
              { name: "From", value: "Sender <sender@example.com>" },
              { name: "Reply-To", value: "replies@example.com" },
              { name: "Subject", value: "Project" },
              { name: "Message-ID", value: "<provider-message@example.com>" },
              { name: "References", value: "<earlier@example.com>" },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ id: "reply-1", threadId: "thread-1" }),
      );
    const result = await createGoogleGmailClient(fetcher).reply(
      "provider-token",
      { messageId: "original-1", body: "Thanks" },
      "reply-request",
    );
    expect(result).toEqual({
      messageId: "reply-1",
      threadId: "thread-1",
      sent: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const requestBody = fetcher.mock.calls[1]?.[1]?.body;
    if (typeof requestBody !== "string") throw new Error("Expected JSON body");
    const payload = JSON.parse(requestBody) as {
      raw: string;
      threadId: string;
    };
    expect(payload.threadId).toBe("thread-1");
    const mime = Buffer.from(payload.raw, "base64url").toString("utf8");
    expect(mime).toContain("To: replies@example.com");
    expect(mime).toContain("Subject: Re: Project");
    expect(mime).toContain("In-Reply-To: <provider-message@example.com>");
  });

  it("requires exact send permission and trusted proof before mutation", async () => {
    const client = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(normalizedMessage()),
      send: vi
        .fn()
        .mockResolvedValue({ messageId: "x", threadId: "y", sent: true }),
      reply: vi
        .fn()
        .mockResolvedValue({ messageId: "x", threadId: "y", sent: true }),
    };
    const executor = new ToolExecutor(gmailRegistry(client));
    const input = { to: "a@example.com", subject: "Hi", body: "Body" };
    await expect(
      executor.execute({ tool: "gmail.messages.send", input, context }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      executor.execute({
        tool: "gmail.messages.send",
        input,
        context: { ...context, grantedPermissions: ["gmail.messages.send"] },
      }),
    ).rejects.toMatchObject({ code: "TOOL_APPROVAL_REQUIRED" });
    expect(client.send).not.toHaveBeenCalled();
  });

  it("rejects injected send/reply fields and exact-action proof mutation", async () => {
    const client = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(normalizedMessage()),
      send: vi
        .fn()
        .mockResolvedValue({ messageId: "x", threadId: "y", sent: true }),
      reply: vi
        .fn()
        .mockResolvedValue({ messageId: "x", threadId: "y", sent: true }),
    };
    const executor = new ToolExecutor(gmailRegistry(client));
    for (const input of [
      { to: "a@example.com\r\nBcc: b@example.com", subject: "Hi", body: "x" },
      { to: "a@example.com", subject: "Hi\r\nBcc: b@example.com", body: "x" },
      {
        to: "a@example.com",
        subject: "Hi",
        body: "x",
        from: "attacker@example.com",
      },
      { to: "a@example.com", subject: "Hi", body: "x", raw: "mime" },
    ])
      await expect(
        executor.execute({
          tool: "gmail.messages.send",
          input,
          context: { ...context, grantedPermissions: ["gmail.messages.send"] },
        }),
      ).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });
    await expect(
      executor.execute({
        tool: "gmail.messages.reply",
        input: { messageId: "original", body: "changed", threadId: "injected" },
        context: { ...context, grantedPermissions: ["gmail.messages.send"] },
      }),
    ).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });
    const approved = { to: "a@example.com", subject: "Hi", body: "approved" };
    await expect(
      executor.execute({
        tool: "gmail.messages.send",
        input: { ...approved, body: "mutated" },
        context: {
          ...context,
          grantedPermissions: ["gmail.messages.send"],
          approval: approval(approved, "gmail.messages.send"),
        },
      }),
    ).rejects.toMatchObject({ code: "TOOL_APPROVAL_REQUIRED" });
    expect(client.send).not.toHaveBeenCalled();
    expect(client.reply).not.toHaveBeenCalled();
  });

  it("does not retry ambiguous sends or send malformed replies", async () => {
    const ambiguousFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("connection reset after dispatch"));
    await expect(
      createGoogleGmailClient(ambiguousFetch).send(
        "provider-token",
        { to: "a@example.com", subject: "Hi", body: "Body" },
        "request-1",
      ),
    ).rejects.toMatchObject({ code: "GMAIL_REQUEST_FAILED" });
    expect(ambiguousFetch).toHaveBeenCalledTimes(1);

    const malformedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(providerMessage("original")));
    await expect(
      createGoogleGmailClient(malformedFetch).reply(
        "provider-token",
        { messageId: "original", body: "Reply" },
        "request-2",
      ),
    ).rejects.toMatchObject({ code: "GMAIL_REQUEST_FAILED" });
    expect(malformedFetch).toHaveBeenCalledTimes(1);
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

function approval(input: unknown, tool: string) {
  return {
    status: "approved" as const,
    approvalId: "approval-1",
    approvedActorId: "actor-1",
    approvedTool: tool,
    approvedToolVersion: 1,
    inputDigest: actionDigest(tool, 1, input),
  };
}
