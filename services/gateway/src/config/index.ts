import { parseEnvironment } from "./env.js";

const DEVELOPMENT_DEFAULTS = {
  NODE_ENV: "development",
  GATEWAY_HOST: "0.0.0.0",
  GATEWAY_PORT: "4000",
  LOG_LEVEL: "info",
} as const;

export interface GatewayConfig {
  readonly runtime: {
    readonly environment: "development" | "test" | "production";
  };
  readonly server: {
    readonly host: string;
    readonly port: number;
  };
  readonly logging: {
    readonly level:
      "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
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
    }),
    logging: Object.freeze({ level: parsed.LOG_LEVEL }),
  });
}
