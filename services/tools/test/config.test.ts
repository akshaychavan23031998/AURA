import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/index.js";
import { ConfigurationError, parseEnvironment } from "../src/config/env.js";

describe("Tool Service configuration", () => {
  it("loads valid immutable configuration", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      TOOLS_HOST: "127.0.0.1",
      TOOLS_PORT: "5001",
      LOG_LEVEL: "warn",
      INTERNAL_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
      INTERNAL_ALLOWED_SERVICE_ID: "gateway",
    });
    expect(config.server).toEqual({
      host: "127.0.0.1",
      port: 5001,
      bodyLimit: 65_536,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(config.internalAuth.allowedServiceId).toBe("gateway");
  });

  it("rejects an invalid port", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "development",
        TOOLS_HOST: "0.0.0.0",
        TOOLS_PORT: "0",
        LOG_LEVEL: "info",
        INTERNAL_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
        INTERNAL_ALLOWED_SERVICE_ID: "gateway",
      }),
    ).toThrow(ConfigurationError);
  });

  it("rejects an invalid environment", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "staging",
        TOOLS_HOST: "0.0.0.0",
        TOOLS_PORT: "4001",
        LOG_LEVEL: "info",
        INTERNAL_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
        INTERNAL_ALLOWED_SERVICE_ID: "gateway",
      }),
    ).toThrow(/NODE_ENV/);
  });

  it("requires a strong internal service token", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "development",
        TOOLS_HOST: "0.0.0.0",
        TOOLS_PORT: "4001",
        LOG_LEVEL: "info",
        INTERNAL_SERVICE_TOKEN: "short",
        INTERNAL_ALLOWED_SERVICE_ID: "gateway",
      }),
    ).toThrow(/INTERNAL_SERVICE_TOKEN/);
  });
});
