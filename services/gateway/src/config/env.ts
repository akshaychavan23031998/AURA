import { z } from "zod";

const authEnvironmentSchema = z.object({
  AUTH_JWT_SECRET: z.string().min(32).max(512),
  AUTH_JWT_ISSUER: z.string().trim().min(1).max(128),
  AUTH_JWT_AUDIENCE: z.string().trim().min(1).max(128),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().min(3600).max(2_592_000),
  TOOL_APPROVAL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600),
  WEB_APP_ORIGIN: z
    .url()
    .refine((url) => url.startsWith("http://") || url.startsWith("https://")),
});

const databaseEnvironmentSchema = z.object({
  DATABASE_URL: z.string().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "postgres:" || url.protocol === "postgresql:";
    } catch {
      return false;
    }
  }, "DATABASE_URL must be a PostgreSQL URL"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(30_000)
    .default(3000),
  DATABASE_QUERY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(5000),
});

const optionalCredential = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).max(512).optional(),
);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    GATEWAY_HOST: z.string().trim().min(1, "GATEWAY_HOST is required"),
    GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535),
    GATEWAY_TRUST_PROXY: z.string().trim().min(1),
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
    AGENT_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000),
    VOICE_SERVICE_URL: z
      .url()
      .refine((url) => url.startsWith("http://") || url.startsWith("https://")),
    VOICE_SERVICE_TOKEN: z.string().min(32),
    VOICE_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000),
    VOICE_MAX_AUDIO_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(20 * 1024 * 1024),
    VOICE_STREAM_MAX_FRAME_BYTES: z.coerce.number().int().min(640).max(65_536),
    VOICE_VAD_THRESHOLD: z.coerce.number().int().min(1).max(32_767),
    VOICE_VAD_END_SILENCE_MS: z.coerce.number().int().min(100).max(5_000),
    VOICE_VAD_MIN_SPEECH_MS: z.coerce.number().int().min(20).max(2_000),
    VOICE_SESSION_IDLE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(3_600_000),
    VOICE_BARGE_IN_ENABLED: z
      .enum(["true", "false"])
      .transform((value) => value === "true"),
    VOICE_BARGE_IN_MIN_SPEECH_MS: z.coerce.number().int().min(20).max(2_000),
    VOICE_INTERRUPT_SETTLE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30_000),
    GOOGLE_OIDC_ENABLED: z
      .enum(["true", "false"])
      .transform((value) => value === "true"),
    GOOGLE_CALENDAR_ENABLED: z
      .enum(["true", "false"])
      .transform((value) => value === "true"),
    GOOGLE_GMAIL_ENABLED: z
      .enum(["true", "false"])
      .transform((value) => value === "true"),
    GOOGLE_CONTACTS_ENABLED: z
      .enum(["true", "false"])
      .transform((value) => value === "true"),
    MEMORY_EMBEDDINGS_ENABLED: z
      .enum(["true", "false"])
      .transform((value) => value === "true"),
    MEMORY_EMBEDDING_BASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().refine(isSafeEmbeddingBaseUrl).optional(),
    ),
    MEMORY_EMBEDDING_MODEL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().trim().min(1).max(128).optional(),
    ),
    MEMORY_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(4096),
    MEMORY_EMBEDDING_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000),
    MEMORY_SEARCH_LIMIT: z.coerce.number().int().min(1).max(10),
    MEMORY_SEARCH_MIN_SIMILARITY: z.coerce.number().min(-1).max(1),
    KNOWLEDGE_SEARCH_LIMIT: z.coerce.number().int().min(1).max(10),
    KNOWLEDGE_SEARCH_MIN_SIMILARITY: z.coerce.number().min(-1).max(1),
    GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine((value) => Buffer.from(value, "base64").length === 32)
        .optional(),
    ),
    GOOGLE_OIDC_CLIENT_ID: optionalCredential,
    GOOGLE_OIDC_CLIENT_SECRET: optionalCredential,
    GOOGLE_OIDC_REDIRECT_URI: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().optional(),
    ),
    ...authEnvironmentSchema.shape,
    ...databaseEnvironmentSchema.shape,
  })
  .superRefine((value, context) => {
    const trustedProxies = value.GATEWAY_TRUST_PROXY.split(",").map((entry) =>
      entry.trim(),
    );
    if (trustedProxies.some((entry) => entry === "" || entry === "*"))
      context.addIssue({
        code: "custom",
        path: ["GATEWAY_TRUST_PROXY"],
        message: "GATEWAY_TRUST_PROXY must contain explicit addresses or CIDRs",
      });
    if (
      value.NODE_ENV === "production" &&
      !value.WEB_APP_ORIGIN.startsWith("https://")
    )
      context.addIssue({
        code: "custom",
        path: ["WEB_APP_ORIGIN"],
        message: "WEB_APP_ORIGIN must use HTTPS in production",
      });
    if (value.GOOGLE_CALENDAR_ENABLED && !value.GOOGLE_OIDC_ENABLED)
      context.addIssue({
        code: "custom",
        path: ["GOOGLE_CALENDAR_ENABLED"],
        message: "Google Calendar requires Google OIDC",
      });
    if (value.GOOGLE_GMAIL_ENABLED && !value.GOOGLE_OIDC_ENABLED)
      context.addIssue({
        code: "custom",
        path: ["GOOGLE_GMAIL_ENABLED"],
        message: "Google Gmail requires Google OIDC",
      });
    if (value.GOOGLE_CONTACTS_ENABLED && !value.GOOGLE_OIDC_ENABLED)
      context.addIssue({
        code: "custom",
        path: ["GOOGLE_CONTACTS_ENABLED"],
        message: "Google Contacts requires Google OIDC",
      });
    if (value.MEMORY_EMBEDDINGS_ENABLED) {
      if (value.MEMORY_EMBEDDING_BASE_URL === undefined)
        context.addIssue({
          code: "custom",
          path: ["MEMORY_EMBEDDING_BASE_URL"],
          message: "Embedding base URL is required when embeddings are enabled",
        });
      if (value.MEMORY_EMBEDDING_MODEL === undefined)
        context.addIssue({
          code: "custom",
          path: ["MEMORY_EMBEDDING_MODEL"],
          message: "Embedding model is required when embeddings are enabled",
        });
      if (value.MEMORY_EMBEDDING_DIMENSIONS !== 384)
        context.addIssue({
          code: "custom",
          path: ["MEMORY_EMBEDDING_DIMENSIONS"],
          message: "The current memory vector schema requires 384 dimensions",
        });
    }
    if (!value.GOOGLE_OIDC_ENABLED) return;
    for (const key of [
      "GOOGLE_OIDC_CLIENT_ID",
      "GOOGLE_OIDC_CLIENT_SECRET",
      "GOOGLE_OIDC_REDIRECT_URI",
    ] as const)
      if (value[key] === undefined)
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required when Google OIDC is enabled`,
        });
    if (
      value.GOOGLE_OIDC_REDIRECT_URI !== undefined &&
      !value.GOOGLE_OIDC_REDIRECT_URI.startsWith("http://") &&
      !value.GOOGLE_OIDC_REDIRECT_URI.startsWith("https://")
    )
      context.addIssue({
        code: "custom",
        path: ["GOOGLE_OIDC_REDIRECT_URI"],
        message: "Google OIDC redirect URI must use HTTP or HTTPS",
      });
    if (
      (value.GOOGLE_CALENDAR_ENABLED ||
        value.GOOGLE_GMAIL_ENABLED ||
        value.GOOGLE_CONTACTS_ENABLED) &&
      value.GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY === undefined
    )
      context.addIssue({
        code: "custom",
        path: ["GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY"],
        message:
          "A 32-byte base64 encryption key is required for Google integrations",
      });
    if (
      value.NODE_ENV === "production" &&
      value.GOOGLE_OIDC_REDIRECT_URI !== undefined &&
      !value.GOOGLE_OIDC_REDIRECT_URI.startsWith("https://")
    )
      context.addIssue({
        code: "custom",
        path: ["GOOGLE_OIDC_REDIRECT_URI"],
        message: "Google OIDC redirect URI must use HTTPS in production",
      });
  });

function isSafeEmbeddingBaseUrl(value: string): boolean {
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    (url.pathname === "/" || url.pathname === "")
  );
}

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

export function parseDatabaseEnvironment(
  input: Record<string, string | undefined>,
) {
  const result = databaseEnvironmentSchema.safeParse(input);
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
