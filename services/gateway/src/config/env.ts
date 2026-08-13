import { z } from "zod";

const authEnvironmentSchema = z.object({
  AUTH_JWT_SECRET: z.string().min(32).max(512),
  AUTH_JWT_ISSUER: z.string().trim().min(1).max(128),
  AUTH_JWT_AUDIENCE: z.string().trim().min(1).max(128),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600),
});

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  GATEWAY_HOST: z.string().trim().min(1, "GATEWAY_HOST is required"),
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535),
  LOG_LEVEL: z.enum([
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
  ]),
  TOOLS_SERVICE_URL: z
    .url()
    .refine((url) => url.startsWith("http://") || url.startsWith("https://")),
  TOOLS_SERVICE_TOKEN: z.string().min(32),
  TOOLS_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000),
  AGENT_SERVICE_URL: z
    .url()
    .refine((url) => url.startsWith("http://") || url.startsWith("https://")),
  AGENT_SERVICE_TOKEN: z.string().min(32),
  AGENT_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000),
  ...authEnvironmentSchema.shape,
});

export type GatewayEnvironment = z.infer<typeof environmentSchema>;

export class ConfigurationError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super(
      `Invalid gateway configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    );
    this.name = "ConfigurationError";
  }
}

export function parseAuthEnvironment(
  input: Record<string, string | undefined>,
) {
  const result = authEnvironmentSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}

export function parseEnvironment(
  input: Record<string, string | undefined>,
): GatewayEnvironment {
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
