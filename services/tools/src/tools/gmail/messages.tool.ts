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
const emailSchema = z
  .email()
  .trim()
  .max(320)
  .refine((value) => !/[\r\n]/u.test(value), "Invalid recipient");
const subjectSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\r\n]/u.test(value), "Invalid subject");
const bodySchema = z.string().min(1).max(20_000);
const sendInputSchema = z
  .object({ to: emailSchema, subject: subjectSchema, body: bodySchema })
  .strict();
const replyInputSchema = z
  .object({ messageId: messageIdSchema, body: bodySchema })
  .strict();
const outboundOutputSchema = z
  .object({
    messageId: messageIdSchema,
    threadId: messageIdSchema,
    sent: z.literal(true),
  })
  .strict();

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
    {
      name: "gmail.messages.send",
      version: 1,
      title: "Send Gmail message",
      description:
        "Sends one plain-text email to one explicit recipient from the authenticated user's Gmail account after explicit approval.",
      category: "communication",
      inputSchema: sendInputSchema,
      outputSchema: outboundOutputSchema,
      requiredPermissions: ["gmail.messages.send"],
      riskLevel: "WRITE",
      approvalPolicy: "REQUIRED",
      idempotency: "NON_IDEMPOTENT",
      timeoutMs: 12_000,
      enabled: true,
      approvalPreview: (untrustedInput) => {
        const input = sendInputSchema.parse(untrustedInput);
        return `Send email to ${input.to}\nSubject: ${input.subject}\n\n${preview(input.body)}`;
      },
      execute: async (input, context) =>
        client.send(accessToken(context), input, context.requestId),
    } satisfies ToolDefinition<
      z.infer<typeof sendInputSchema>,
      z.infer<typeof outboundOutputSchema>
    >,
    {
      name: "gmail.messages.reply",
      version: 1,
      title: "Reply to Gmail message",
      description:
        "Replies with plain text to one explicit Gmail message after deriving its recipient and threading metadata server-side and receiving explicit approval.",
      category: "communication",
      inputSchema: replyInputSchema,
      outputSchema: outboundOutputSchema,
      requiredPermissions: ["gmail.messages.send"],
      riskLevel: "WRITE",
      approvalPolicy: "REQUIRED",
      idempotency: "NON_IDEMPOTENT",
      timeoutMs: 12_000,
      enabled: true,
      approvalPreview: (untrustedInput) => {
        const input = replyInputSchema.parse(untrustedInput);
        return `Reply to message ${input.messageId}\n\n${preview(input.body)}`;
      },
      execute: async (input, context) =>
        client.reply(accessToken(context), input, context.requestId),
    } satisfies ToolDefinition<
      z.infer<typeof replyInputSchema>,
      z.infer<typeof outboundOutputSchema>
    >,
  ];
}

function preview(body: string): string {
  return body.length <= 500 ? body : `${body.slice(0, 497)}...`;
}
