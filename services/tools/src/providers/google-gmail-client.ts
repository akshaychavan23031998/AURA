import { z } from "zod";

import { ToolError } from "../errors/tool-error.js";

const GOOGLE_GMAIL_ORIGIN = "https://gmail.googleapis.com";
const messageReferenceSchema = z
  .object({ id: z.string().min(1).max(256) })
  .passthrough();
const listResponseSchema = z
  .object({ messages: z.array(messageReferenceSchema).max(20).optional() })
  .passthrough();
const providerMessageSchema = z
  .object({
    id: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256),
    snippet: z.string().max(4096).optional(),
    payload: z
      .object({
        headers: z
          .array(
            z
              .object({
                name: z.string().max(128),
                value: z.string().max(8192),
              })
              .passthrough(),
          )
          .max(100)
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();
const sentMessageSchema = z
  .object({
    id: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256),
  })
  .passthrough();

export interface GmailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  readonly to: string;
  readonly cc?: string;
  readonly subject: string;
  readonly date: string;
  readonly snippet: string;
}

export interface GmailOutboundMessage {
  readonly messageId: string;
  readonly threadId: string;
  readonly sent: true;
}

export interface GoogleGmailClient {
  list(
    accessToken: string,
    input: { readonly maxResults: number; readonly query?: string | undefined },
    requestId: string,
  ): Promise<GmailMessage[]>;
  get(
    accessToken: string,
    messageId: string,
    requestId: string,
  ): Promise<GmailMessage>;
  send(
    accessToken: string,
    input: {
      readonly to: string;
      readonly subject: string;
      readonly body: string;
    },
    requestId: string,
  ): Promise<GmailOutboundMessage>;
  reply(
    accessToken: string,
    input: { readonly messageId: string; readonly body: string },
    requestId: string,
  ): Promise<GmailOutboundMessage>;
}

export function createGoogleGmailClient(
  fetcher: typeof fetch = fetch,
): GoogleGmailClient {
  const request = async (
    url: URL,
    token: string,
    requestId: string,
    init: Readonly<{ method?: "GET" | "POST"; body?: string }> = {},
  ) => {
    if (url.origin !== GOOGLE_GMAIL_ORIGIN)
      throw new Error("Invalid Gmail origin");
    let response: Response;
    try {
      response = await fetcher(url, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "x-request-id": requestId,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ToolError("GMAIL_REQUEST_FAILED", 502, "Gmail request failed", {
        cause: error,
      });
    }
    if (response.status === 401 || response.status === 403)
      throw new ToolError(
        "PROVIDER_REAUTH_REQUIRED",
        409,
        "Google Gmail reconnection is required",
      );
    if (response.status === 429)
      throw new ToolError(
        "GMAIL_RATE_LIMITED",
        429,
        "Google Gmail rate limit reached",
      );
    if (!response.ok)
      throw new ToolError("GMAIL_REQUEST_FAILED", 502, "Gmail request failed");
    return response.json();
  };

  const get = async (token: string, messageId: string, requestId: string) => {
    const url = new URL(
      `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
      GOOGLE_GMAIL_ORIGIN,
    );
    url.searchParams.set("format", "metadata");
    for (const name of [
      "From",
      "Reply-To",
      "To",
      "Cc",
      "Subject",
      "Date",
      "Message-ID",
      "References",
    ])
      url.searchParams.append("metadataHeaders", name);
    const parsed = providerMessageSchema.safeParse(
      await request(url, token, requestId),
    );
    if (!parsed.success)
      throw new ToolError(
        "GMAIL_REQUEST_FAILED",
        502,
        "Gmail returned invalid data",
      );
    return normalizeMessage(parsed.data);
  };

  return {
    async list(token, input, requestId) {
      const url = new URL("/gmail/v1/users/me/messages", GOOGLE_GMAIL_ORIGIN);
      url.searchParams.set("maxResults", String(input.maxResults));
      if (input.query !== undefined) url.searchParams.set("q", input.query);
      const parsed = listResponseSchema.safeParse(
        await request(url, token, requestId),
      );
      if (!parsed.success)
        throw new ToolError(
          "GMAIL_REQUEST_FAILED",
          502,
          "Gmail returned invalid data",
        );
      return Promise.all(
        (parsed.data.messages ?? []).map((message) =>
          get(token, message.id, requestId),
        ),
      );
    },
    get,
    async send(token, input, requestId) {
      return sendRaw(
        token,
        requestId,
        buildMimeMessage(input.to, input.subject, input.body),
      );
    },
    async reply(token, input, requestId) {
      const original = await getProviderMessage(
        token,
        input.messageId,
        requestId,
      );
      const headers = providerHeaders(original);
      const recipient = extractEmail(
        headers.get("reply-to") ?? headers.get("from") ?? "",
      );
      const messageId = bounded(headers.get("message-id") ?? "", 998);
      if (recipient === undefined || messageId.length === 0)
        throw new ToolError(
          "GMAIL_REQUEST_FAILED",
          502,
          "Gmail message cannot be replied to safely",
        );
      const originalSubject = bounded(headers.get("subject") ?? "", 200);
      const subject = /^\s*re:/iu.test(originalSubject)
        ? originalSubject
        : `Re: ${originalSubject || "(no subject)"}`;
      const references = [headers.get("references"), messageId]
        .filter(
          (value): value is string => value !== undefined && value.length > 0,
        )
        .join(" ")
        .slice(0, 1998);
      return sendRaw(
        token,
        requestId,
        buildMimeMessage(recipient, subject, input.body, {
          inReplyTo: messageId,
          references,
        }),
        original.threadId,
      );
    },
  };

  async function getProviderMessage(
    token: string,
    messageId: string,
    requestId: string,
  ): Promise<z.infer<typeof providerMessageSchema>> {
    const url = new URL(
      `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
      GOOGLE_GMAIL_ORIGIN,
    );
    url.searchParams.set("format", "metadata");
    for (const name of [
      "From",
      "Reply-To",
      "Subject",
      "Message-ID",
      "References",
    ])
      url.searchParams.append("metadataHeaders", name);
    const parsed = providerMessageSchema.safeParse(
      await request(url, token, requestId),
    );
    if (!parsed.success)
      throw new ToolError(
        "GMAIL_REQUEST_FAILED",
        502,
        "Gmail returned invalid data",
      );
    return parsed.data;
  }

  async function sendRaw(
    token: string,
    requestId: string,
    mime: string,
    threadId?: string,
  ): Promise<GmailOutboundMessage> {
    const url = new URL(
      "/gmail/v1/users/me/messages/send",
      GOOGLE_GMAIL_ORIGIN,
    );
    const payload = JSON.stringify({
      raw: Buffer.from(mime, "utf8").toString("base64url"),
      ...(threadId === undefined ? {} : { threadId }),
    });
    const parsed = sentMessageSchema.safeParse(
      await request(url, token, requestId, { method: "POST", body: payload }),
    );
    if (!parsed.success)
      throw new ToolError(
        "GMAIL_REQUEST_FAILED",
        502,
        "Gmail returned invalid data",
      );
    return {
      messageId: parsed.data.id,
      threadId: parsed.data.threadId,
      sent: true,
    };
  }
}

function normalizeMessage(
  message: z.infer<typeof providerMessageSchema>,
): GmailMessage {
  const headers = new Map(
    (message.payload.headers ?? []).map((header) => [
      header.name.toLowerCase(),
      header.value,
    ]),
  );
  const cc = headers.get("cc");
  return {
    id: message.id,
    threadId: message.threadId,
    from: bounded(headers.get("from") ?? "", 1000),
    to: bounded(headers.get("to") ?? "", 1000),
    subject: bounded(headers.get("subject") ?? "", 1000),
    date: bounded(headers.get("date") ?? "", 200),
    snippet: bounded(message.snippet ?? "", 1000),
    ...(cc === undefined ? {} : { cc: bounded(cc, 1000) }),
  };
}

function providerHeaders(message: z.infer<typeof providerMessageSchema>) {
  return new Map(
    (message.payload.headers ?? []).map((header) => [
      header.name.toLowerCase(),
      header.value,
    ]),
  );
}

export function buildMimeMessage(
  to: string,
  subject: string,
  body: string,
  threading?: Readonly<{ inReplyTo: string; references: string }>,
): string {
  const safeTo = requireHeaderValue(to);
  const safeSubject = encodeSubject(requireHeaderValue(subject));
  const normalizedBody = body.replace(/\r\n|\r|\n/g, "\r\n");
  const headers = [
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    ...(threading === undefined
      ? []
      : [
          `In-Reply-To: ${requireHeaderValue(threading.inReplyTo)}`,
          `References: ${requireHeaderValue(threading.references)}`,
        ]),
  ];
  return `${headers.join("\r\n")}\r\n\r\n${normalizedBody}`;
}

function encodeSubject(value: string): string {
  return /^[\x20-\x7E]*$/u.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function requireHeaderValue(value: string): string {
  if (/[\r\n]/u.test(value)) throw new Error("Unsafe email header value");
  return value;
}

function extractEmail(value: string): string | undefined {
  if (/[\r\n]/u.test(value)) return undefined;
  const angle = /<([^<>]+)>/u.exec(value)?.[1];
  const candidate = (angle ?? value).trim();
  return z.email().max(320).safeParse(candidate).success
    ? candidate
    : undefined;
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum);
}
