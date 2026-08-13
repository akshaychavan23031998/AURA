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
    });

    expect(config).toEqual({
      runtime: { environment: "production" },
      server: { host: "127.0.0.1", port: 8080 },
      logging: { level: "warn" },
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
      }),
    ).toThrow(/NODE_ENV/);
  });

  it("rejects missing required configuration when parsing an explicit environment", () => {
    expect(() => parseEnvironment({})).toThrow(/GATEWAY_HOST/);
  });
});
