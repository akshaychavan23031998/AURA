import { z } from "zod";

import type { ToolDefinition } from "../../registry/tool-definition.js";

const inputSchema = z
  .object({
    operation: z.enum(["current_time", "current_date"]),
    timezone: z.string().min(1).max(64),
  })
  .strict()
  .refine(({ timezone }) => isValidTimeZone(timezone), {
    message: "Invalid IANA timezone",
    path: ["timezone"],
  });
const outputSchema = z
  .object({
    timezone: z.string(),
    iso: z.string(),
    date: z.string(),
    time: z.string(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

export function createDatetimeTool(
  now: () => Date = () => new Date(),
): ToolDefinition<Input, Output> {
  return {
    name: "utility.datetime",
    version: 1,
    title: "Current date and time",
    description:
      "Returns the current server-observed date and time for an explicit IANA timezone.",
    category: "utility",
    inputSchema,
    outputSchema,
    requiredPermissions: ["utility.datetime"],
    riskLevel: "READ",
    approvalPolicy: "NONE",
    idempotency: "NON_IDEMPOTENT",
    timeoutMs: 1_000,
    enabled: true,
    execute: ({ timezone }) => {
      const instant = now();
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(instant);
      const get = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((part) => part.type === type)?.value ?? "";
      return Promise.resolve({
        timezone,
        iso: instant.toISOString(),
        date: `${get("year")}-${get("month")}-${get("day")}`,
        time: `${get("hour")}:${get("minute")}:${get("second")}`,
      });
    },
  };
}

export const datetimeTool = createDatetimeTool();

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}
