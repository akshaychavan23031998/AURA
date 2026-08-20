import { z } from "zod";
import { ToolError } from "../../errors/tool-error.js";
import type { GoogleContactsClient } from "../../providers/google-contacts-client.js";
import type { ToolDefinition } from "../../registry/tool-definition.js";
const resourceName = z
  .string()
  .min(8)
  .max(256)
  .regex(/^people\/[A-Za-z0-9_-]+$/);
const value = z
  .object({
    value: z.string().min(1).max(500),
    type: z.string().max(100).optional(),
  })
  .strict();
const contact = z
  .object({
    resourceName,
    displayName: z.string().max(500),
    emailAddresses: z.array(value).max(20),
    phoneNumbers: z.array(value).max(20),
  })
  .strict();
const listInput = z
  .object({ maxResults: z.number().int().min(1).max(25).default(10) })
  .strict();
const getInput = z.object({ resourceName }).strict();
export function createContactsTools(
  client: GoogleContactsClient,
): readonly ToolDefinition<unknown, unknown>[] {
  const token = (c: { providerAccessToken?: string }) => {
    if (c.providerAccessToken === undefined)
      throw new ToolError(
        "PROVIDER_REAUTH_REQUIRED",
        409,
        "Google Contacts connection is required",
      );
    return c.providerAccessToken;
  };
  return [
    {
      name: "contacts.people.list",
      version: 1,
      title: "List Google contacts",
      description:
        "Lists a bounded set of the authenticated user's Google contacts.",
      category: "productivity",
      inputSchema: listInput,
      outputSchema: z.object({ contacts: z.array(contact).max(25) }).strict(),
      requiredPermissions: ["contacts.people.read"],
      riskLevel: "READ",
      approvalPolicy: "NONE",
      idempotency: "IDEMPOTENT",
      timeoutMs: 12_000,
      enabled: true,
      execute: async (i, c) => ({
        contacts: await client.list(token(c), i.maxResults, c.requestId),
      }),
    } satisfies ToolDefinition<z.infer<typeof listInput>, unknown>,
    {
      name: "contacts.people.get",
      version: 1,
      title: "Get Google contact",
      description:
        "Gets one Google contact by an explicit People API resource name.",
      category: "productivity",
      inputSchema: getInput,
      outputSchema: z.object({ contact }).strict(),
      requiredPermissions: ["contacts.people.read"],
      riskLevel: "READ",
      approvalPolicy: "NONE",
      idempotency: "IDEMPOTENT",
      timeoutMs: 12_000,
      enabled: true,
      execute: async (i, c) => ({
        contact: await client.get(token(c), i.resourceName, c.requestId),
      }),
    } satisfies ToolDefinition<z.infer<typeof getInput>, unknown>,
  ];
}
