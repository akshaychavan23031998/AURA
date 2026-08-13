import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  TOOLS_HOST: z.string().trim().min(1, "TOOLS_HOST is required"),
  TOOLS_PORT: z.coerce.number().int().min(1).max(65_535),
  LOG_LEVEL: z.enum([
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
  ]),
});

export class ConfigurationError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super(
      `Invalid Tool Service configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    );
    this.name = "ConfigurationError";
  }
}

export function parseEnvironment(input: Record<string, string | undefined>) {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
