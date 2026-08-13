import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/index.js";
import { ConfigurationError, parseEnvironment } from "../src/config/env.js";

describe("gateway configuration", () => {
  it("loads a valid, typed configuration", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: "8080",
      LOG_LEVEL: "warn",
      TOOLS_SERVICE_URL: "http://127.0.0.1:4001",
      TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
      TOOLS_SERVICE_TIMEOUT_MS: "2500",
    });

    expect(config).toEqual({
      runtime: { environment: "production" },
      server: { host: "127.0.0.1", port: 8080, bodyLimit: 65_536 },
      logging: { level: "warn" },
      toolsService: {
        url: "http://127.0.0.1:4001",
        token: "gateway-test-token-at-least-32-characters",
        timeoutMs: 2500,
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("rejects an invalid port", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "development",
        GATEWAY_HOST: "0.0.0.0",
        GATEWAY_PORT: "70000",
        LOG_LEVEL: "info",
        TOOLS_SERVICE_URL: "http://localhost:4001",
        TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
        TOOLS_SERVICE_TIMEOUT_MS: "3000",
      }),
    ).toThrow(ConfigurationError);
  });

  it("rejects an invalid runtime environment", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "staging",
        GATEWAY_HOST: "0.0.0.0",
        GATEWAY_PORT: "4000",
        LOG_LEVEL: "info",
        TOOLS_SERVICE_URL: "http://localhost:4001",
        TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
        TOOLS_SERVICE_TIMEOUT_MS: "3000",
      }),
    ).toThrow(/NODE_ENV/);
  });

  it("rejects missing required configuration when parsing an explicit environment", () => {
    expect(() => parseEnvironment({})).toThrow(/GATEWAY_HOST/);
  });

  it("requires a strong Tool Service token", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "development",
        GATEWAY_HOST: "0.0.0.0",
        GATEWAY_PORT: "4000",
        LOG_LEVEL: "info",
        TOOLS_SERVICE_URL: "http://localhost:4001",
        TOOLS_SERVICE_TOKEN: "short",
        TOOLS_SERVICE_TIMEOUT_MS: "3000",
      }),
    ).toThrow(/TOOLS_SERVICE_TOKEN/);
  });
});
