import { parseEnvironment } from "./env.js";

const DEVELOPMENT_DEFAULTS = {
  NODE_ENV: "development",
  GATEWAY_HOST: "0.0.0.0",
  GATEWAY_PORT: "4000",
  LOG_LEVEL: "info",
  TOOLS_SERVICE_URL: "http://localhost:4001",
  TOOLS_SERVICE_TIMEOUT_MS: "3000",
} as const;

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
  });
}
