import type { GatewayConfig } from "../src/config/index.js";

export const testConfig: GatewayConfig = {
  runtime: { environment: "test" },
  server: { host: "127.0.0.1", port: 4000, bodyLimit: 65_536 },
  logging: { level: "silent" },
  toolsService: {
    url: "http://127.0.0.1:4001",
    token: "gateway-test-token-at-least-32-characters",
    timeoutMs: 1000,
  },
};
