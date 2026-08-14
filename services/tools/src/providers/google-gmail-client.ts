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
}

export function createGoogleGmailClient(
  fetcher: typeof fetch = fetch,
): GoogleGmailClient {
  const request = async (url: URL, token: string, requestId: string) => {
    if (url.origin !== GOOGLE_GMAIL_ORIGIN)
      throw new Error("Invalid Gmail origin");
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: {
          authorization: `Bearer ${token}`,
          "x-request-id": requestId,
        },
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
    for (const name of ["From", "To", "Cc", "Subject", "Date"])
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
  };
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

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum);
}
