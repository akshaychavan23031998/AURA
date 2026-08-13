import type { GatewayConfig } from "../src/config/index.js";

export const testConfig: GatewayConfig = {
  runtime: { environment: "test" },
  server: { host: "127.0.0.1", port: 4000 },
  logging: { level: "silent" },
};
