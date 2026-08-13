import type { ToolsConfig } from "../src/config/index.js";

export const testConfig: ToolsConfig = {
  runtime: { environment: "test" },
  server: { host: "127.0.0.1", port: 4001, bodyLimit: 64 * 1024 },
  logging: { level: "silent" },
};
