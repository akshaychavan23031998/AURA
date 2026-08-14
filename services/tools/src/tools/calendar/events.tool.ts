import { z } from "zod";
import { ToolError } from "../../errors/tool-error.js";
import type { GoogleCalendarClient } from "../../providers/google-calendar-client.js";
import type { ToolDefinition } from "../../registry/tool-definition.js";

const normalizedEventSchema = z
  .object({
    eventId: z.string(),
    title: z.string(),
    start: z.string(),
    end: z.string(),
    timezone: z.string().optional(),
    status: z.string(),
    location: z.string().optional(),
  })
  .strict();
const listInputSchema = z
  .object({
    timeMin: z.iso.datetime({ offset: true }),
    timeMax: z.iso.datetime({ offset: true }),
    maxResults: z.number().int().min(1).max(50).default(10),
  })
  .strict()
  .refine(
    ({ timeMin, timeMax }) => {
      const start = Date.parse(timeMin);
      const end = Date.parse(timeMax);
      return end > start && end - start <= 31 * 24 * 60 * 60 * 1_000;
    },
    { message: "Calendar window must be positive and at most 31 days" },
  );
const listOutputSchema = z
  .object({ events: z.array(normalizedEventSchema).max(50) })
  .strict();
const getInputSchema = z
  .object({ eventId: z.string().min(1).max(1024) })
  .strict();
const getOutputSchema = z.object({ event: normalizedEventSchema }).strict();
const createInputSchema = z
  .object({
    summary: z.string().trim().min(1).max(200),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(isIanaTimezone, "Timezone must be a valid IANA timezone"),
    location: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine(
    ({ start, end }) => {
      const duration = Date.parse(end) - Date.parse(start);
      return duration > 0 && duration <= 24 * 60 * 60 * 1_000;
    },
    { message: "Event duration must be positive and at most 24 hours" },
  );
const createOutputSchema = z.object({ event: normalizedEventSchema }).strict();

export function createCalendarTools(
  client: GoogleCalendarClient,
): readonly ToolDefinition<unknown, unknown>[] {
  const accessToken = (context: { providerAccessToken?: string }) => {
    if (context.providerAccessToken === undefined)
      throw new ToolError(
        "PROVIDER_REAUTH_REQUIRED",
        409,
        "Google Calendar connection is required",
      );
    return context.providerAccessToken;
  };
  return [
    {
      name: "calendar.events.list",
      version: 1,
      title: "List calendar events",
      description:
        "Lists events from the authenticated user's primary Google Calendar within a bounded time window.",
      category: "productivity",
      inputSchema: listInputSchema,
      outputSchema: listOutputSchema,
      requiredPermissions: ["calendar.events.read"],
      riskLevel: "READ",
      approvalPolicy: "NONE",
      idempotency: "IDEMPOTENT",
      timeoutMs: 12_000,
      enabled: true,
      execute: async (input, context) => ({
        events: await client.list(
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
      name: "calendar.events.get",
      version: 1,
      title: "Get calendar event",
      description:
        "Gets one event from the authenticated user's primary Google Calendar by its bounded event identifier.",
      category: "productivity",
      inputSchema: getInputSchema,
      outputSchema: getOutputSchema,
      requiredPermissions: ["calendar.events.read"],
      riskLevel: "READ",
      approvalPolicy: "NONE",
      idempotency: "IDEMPOTENT",
      timeoutMs: 12_000,
      enabled: true,
      execute: async (input, context) => ({
        event: await client.get(
          accessToken(context),
          input.eventId,
          context.requestId,
        ),
      }),
    } satisfies ToolDefinition<
      z.infer<typeof getInputSchema>,
      z.infer<typeof getOutputSchema>
    >,
    {
      name: "calendar.events.create",
      version: 1,
      title: "Create calendar event",
      description:
        "Creates one event on the authenticated user's primary Google Calendar after explicit approval.",
      category: "productivity",
      inputSchema: createInputSchema,
      outputSchema: createOutputSchema,
      requiredPermissions: ["calendar.events.write"],
      riskLevel: "WRITE",
      approvalPolicy: "REQUIRED",
      idempotency: "NON_IDEMPOTENT",
      timeoutMs: 12_000,
      enabled: true,
      approvalPreview: (untrustedInput) => {
        const input = createInputSchema.parse(untrustedInput);
        return [
          input.summary,
          `${input.start} – ${input.end}`,
          input.timezone,
          ...(input.location === undefined
            ? []
            : [`Location: ${input.location}`]),
        ].join("\n");
      },
      execute: async (input, context) => ({
        event: await client.create(
          accessToken(context),
          input,
          context.requestId,
        ),
      }),
    } satisfies ToolDefinition<
      z.infer<typeof createInputSchema>,
      z.infer<typeof createOutputSchema>
    >,
  ];
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value.includes("/") || value === "UTC";
  } catch {
    return false;
  }
}
