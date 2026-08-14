import { z } from "zod";

import { ToolError } from "../../errors/tool-error.js";
import type { GoogleGmailClient } from "../../providers/google-gmail-client.js";
import type { ToolDefinition } from "../../registry/tool-definition.js";

const messageIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const normalizedMessageSchema = z
  .object({
    id: messageIdSchema,
    threadId: messageIdSchema,
    from: z.string().max(1000),
    to: z.string().max(1000),
    cc: z.string().max(1000).optional(),
    subject: z.string().max(1000),
    date: z.string().max(200),
    snippet: z.string().max(1000),
  })
  .strict();
const querySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      !value.includes(":") &&
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 32 && code !== 127;
      }),
    "Only plain Gmail search terms are supported",
  );
const listInputSchema = z
  .object({
    maxResults: z.number().int().min(1).max(20).default(10),
    query: querySchema.optional(),
  })
  .strict();
const listOutputSchema = z
  .object({ messages: z.array(normalizedMessageSchema).max(20) })
  .strict();
const getInputSchema = z.object({ messageId: messageIdSchema }).strict();
const getOutputSchema = z.object({ message: normalizedMessageSchema }).strict();

export function createGmailTools(
  client: GoogleGmailClient,
): readonly ToolDefinition<unknown, unknown>[] {
  const accessToken = (context: { providerAccessToken?: string }) => {
    if (context.providerAccessToken === undefined)
      throw new ToolError(
        "PROVIDER_REAUTH_REQUIRED",
        409,
        "Google Gmail connection is required",
      );
    return context.providerAccessToken;
  };
  return [
    {
      name: "gmail.messages.list",
      version: 1,
      title: "List Gmail messages",
      description:
        "Lists bounded metadata for recent messages in the authenticated user's Gmail account, optionally filtered by plain search terms.",
      category: "communication",
      inputSchema: listInputSchema,
      outputSchema: listOutputSchema,
      requiredPermissions: ["gmail.messages.read"],
      riskLevel: "READ",
      approvalPolicy: "NONE",
      idempotency: "IDEMPOTENT",
      timeoutMs: 12_000,
      enabled: true,
      execute: async (input, context) => ({
        messages: await client.list(
          accessToken(context),
          input,
          context.requestId,
        ),
      }),
    } satisfies ToolDefinition<
      z.infer<typeof listInputSchema>,
      z.infer<typeof listOutputSchema>
    >,
    {
      name: "gmail.messages.get",
      version: 1,
      title: "Get Gmail message",
      description:
        "Gets bounded metadata and a snippet for one Gmail message by its explicit message identifier.",
      category: "communication",
      inputSchema: getInputSchema,
      outputSchema: getOutputSchema,
      requiredPermissions: ["gmail.messages.read"],
      riskLevel: "READ",
      approvalPolicy: "NONE",
      idempotency: "IDEMPOTENT",
      timeoutMs: 12_000,
      enabled: true,
      execute: async (input, context) => ({
        message: await client.get(
          accessToken(context),
          input.messageId,
          context.requestId,
        ),
      }),
    } satisfies ToolDefinition<
      z.infer<typeof getInputSchema>,
      z.infer<typeof getOutputSchema>
    >,
  ];
}
