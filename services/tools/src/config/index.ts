import { parseEnvironment } from "./env.js";

const DEFAULTS = {
  NODE_ENV: "development",
  TOOLS_HOST: "0.0.0.0",
  TOOLS_PORT: "4001",
  LOG_LEVEL: "info",
} as const;

export interface ToolsConfig {
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
  readonly internalAuth: {
    readonly token: string;
    readonly allowedServiceId: "gateway";
  };
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ToolsConfig {
  const parsed = parseEnvironment({ ...DEFAULTS, ...environment });
  return Object.freeze({
    runtime: Object.freeze({ environment: parsed.NODE_ENV }),
    server: Object.freeze({
      host: parsed.TOOLS_HOST,
      port: parsed.TOOLS_PORT,
      bodyLimit: 64 * 1024,
    }),
    logging: Object.freeze({ level: parsed.LOG_LEVEL }),
    internalAuth: Object.freeze({
      token: parsed.INTERNAL_SERVICE_TOKEN,
      allowedServiceId: parsed.INTERNAL_ALLOWED_SERVICE_ID,
    }),
  });
}
