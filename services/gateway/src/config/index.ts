import {
  parseAuthEnvironment,
  parseDatabaseEnvironment,
  parseEnvironment,
} from "./env.js";

const DEVELOPMENT_DEFAULTS = {
  NODE_ENV: "development",
  GATEWAY_HOST: "0.0.0.0",
  GATEWAY_PORT: "4000",
  LOG_LEVEL: "info",
  TOOLS_SERVICE_URL: "http://localhost:4001",
  TOOLS_SERVICE_TIMEOUT_MS: "3000",
  AGENT_SERVICE_URL: "http://localhost:8001",
  AGENT_SERVICE_TIMEOUT_MS: "5000",
  VOICE_SERVICE_URL: "http://localhost:8002",
  VOICE_SERVICE_TIMEOUT_MS: "180000",
  VOICE_MAX_AUDIO_BYTES: "10485760",
  VOICE_STREAM_MAX_FRAME_BYTES: "640",
  VOICE_VAD_THRESHOLD: "500",
  VOICE_VAD_END_SILENCE_MS: "600",
  VOICE_VAD_MIN_SPEECH_MS: "100",
  VOICE_SESSION_IDLE_TIMEOUT_MS: "120000",
  VOICE_BARGE_IN_ENABLED: "true",
  VOICE_BARGE_IN_MIN_SPEECH_MS: "100",
  VOICE_INTERRUPT_SETTLE_TIMEOUT_MS: "5000",
  AUTH_JWT_ISSUER: "aura-gateway",
  AUTH_JWT_AUDIENCE: "aura-api",
  AUTH_ACCESS_TOKEN_TTL_SECONDS: "900",
  AUTH_SESSION_TTL_SECONDS: "604800",
  WEB_APP_ORIGIN: "http://localhost:3000",
  GOOGLE_OIDC_ENABLED: "false",
} as const;

export interface AuthConfig {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly accessTokenTtlSeconds: number;
  readonly sessionTtlSeconds: number;
}

export interface GatewayConfig {
  readonly runtime: {
    readonly environment: "development" | "test" | "production";
  };
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly bodyLimit: number;
  };
  readonly logging: {
    readonly level:
      "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  };
  readonly toolsService: {
    readonly url: string;
    readonly token: string;
    readonly timeoutMs: number;
  };
  readonly agentService: {
    readonly url: string;
    readonly token: string;
    readonly timeoutMs: number;
  };
  readonly voiceService: {
    readonly url: string;
    readonly token: string;
    readonly timeoutMs: number;
    readonly maxAudioBytes: number;
  };
  readonly voiceStream: {
    readonly frameBytes: 640;
    readonly maxFrameBytes: number;
    readonly maxBufferBytes: 960000;
    readonly maxUtteranceMs: 30000;
    readonly audioChunkBytes: 16384;
    readonly vadThreshold: number;
    readonly vadMinSpeechMs: number;
    readonly vadEndSilenceMs: number;
    readonly frameMs: 20;
    readonly idleTimeoutMs: number;
    readonly bargeInEnabled: boolean;
    readonly bargeInMinSpeechMs: number;
    readonly interruptSettleTimeoutMs: number;
  };
  readonly auth: AuthConfig;
  readonly browser: {
    readonly origin: string;
    readonly secureCookies: boolean;
    readonly developmentSessionEnabled: boolean;
  };
  readonly googleOidc:
    | { readonly enabled: false }
    | {
        readonly enabled: true;
        readonly clientId: string;
        readonly clientSecret: string;
        readonly redirectUri: string;
        readonly transactionTtlSeconds: 600;
      };
  readonly database: { readonly url: string };
}

export interface DatabaseConfig {
  readonly url: string;
}

export function loadAuthConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  const parsed = parseAuthEnvironment({
    ...DEVELOPMENT_DEFAULTS,
    ...environment,
  });
  return Object.freeze({
    secret: parsed.AUTH_JWT_SECRET,
    issuer: parsed.AUTH_JWT_ISSUER,
    audience: parsed.AUTH_JWT_AUDIENCE,
    accessTokenTtlSeconds: parsed.AUTH_ACCESS_TOKEN_TTL_SECONDS,
    sessionTtlSeconds: parsed.AUTH_SESSION_TTL_SECONDS,
  });
}

export function loadDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const parsed = parseDatabaseEnvironment(environment);
  return Object.freeze({ url: parsed.DATABASE_URL });
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const parsed = parseEnvironment({ ...DEVELOPMENT_DEFAULTS, ...environment });

  return Object.freeze({
    runtime: Object.freeze({ environment: parsed.NODE_ENV }),
    server: Object.freeze({
      host: parsed.GATEWAY_HOST,
      port: parsed.GATEWAY_PORT,
      bodyLimit: 64 * 1024,
    }),
    logging: Object.freeze({ level: parsed.LOG_LEVEL }),
    toolsService: Object.freeze({
      url: parsed.TOOLS_SERVICE_URL.replace(/\/$/, ""),
      token: parsed.TOOLS_SERVICE_TOKEN,
      timeoutMs: parsed.TOOLS_SERVICE_TIMEOUT_MS,
    }),
    agentService: Object.freeze({
      url: parsed.AGENT_SERVICE_URL.replace(/\/$/, ""),
      token: parsed.AGENT_SERVICE_TOKEN,
      timeoutMs: parsed.AGENT_SERVICE_TIMEOUT_MS,
    }),
    voiceService: Object.freeze({
      url: parsed.VOICE_SERVICE_URL.replace(/\/$/, ""),
      token: parsed.VOICE_SERVICE_TOKEN,
      timeoutMs: parsed.VOICE_SERVICE_TIMEOUT_MS,
      maxAudioBytes: parsed.VOICE_MAX_AUDIO_BYTES,
    }),
    voiceStream: Object.freeze({
      frameBytes: 640 as const,
      maxFrameBytes: parsed.VOICE_STREAM_MAX_FRAME_BYTES,
      maxBufferBytes: 960000 as const,
      maxUtteranceMs: 30000 as const,
      audioChunkBytes: 16384 as const,
      vadThreshold: parsed.VOICE_VAD_THRESHOLD,
      vadMinSpeechMs: parsed.VOICE_VAD_MIN_SPEECH_MS,
      vadEndSilenceMs: parsed.VOICE_VAD_END_SILENCE_MS,
      frameMs: 20 as const,
      idleTimeoutMs: parsed.VOICE_SESSION_IDLE_TIMEOUT_MS,
      bargeInEnabled: parsed.VOICE_BARGE_IN_ENABLED,
      bargeInMinSpeechMs: parsed.VOICE_BARGE_IN_MIN_SPEECH_MS,
      interruptSettleTimeoutMs: parsed.VOICE_INTERRUPT_SETTLE_TIMEOUT_MS,
    }),
    auth: Object.freeze({
      secret: parsed.AUTH_JWT_SECRET,
      issuer: parsed.AUTH_JWT_ISSUER,
      audience: parsed.AUTH_JWT_AUDIENCE,
      accessTokenTtlSeconds: parsed.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      sessionTtlSeconds: parsed.AUTH_SESSION_TTL_SECONDS,
    }),
    browser: Object.freeze({
      origin: parsed.WEB_APP_ORIGIN.replace(/\/$/, ""),
      secureCookies: parsed.NODE_ENV === "production",
      developmentSessionEnabled: parsed.NODE_ENV === "development",
    }),
    googleOidc: parsed.GOOGLE_OIDC_ENABLED
      ? Object.freeze({
          enabled: true as const,
          clientId: parsed.GOOGLE_OIDC_CLIENT_ID!,
          clientSecret: parsed.GOOGLE_OIDC_CLIENT_SECRET!,
          redirectUri: parsed.GOOGLE_OIDC_REDIRECT_URI!,
          transactionTtlSeconds: 600 as const,
        })
      : Object.freeze({ enabled: false as const }),
    database: Object.freeze({ url: parsed.DATABASE_URL }),
  });
}
