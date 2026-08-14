import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { createApp } from "../src/app/create-app.js";
import { testConfig } from "./test-config.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("trusted proxy boundary", () => {
  it("ignores forwarded client addresses from an untrusted peer", async () => {
    app = await createApp({ config: testConfig });
    app.get("/_test/client-ip", (request) => ({ ip: request.ip }));

    const response = await app.inject({
      method: "GET",
      url: "/_test/client-ip",
      remoteAddress: "203.0.113.10",
      headers: { "x-forwarded-for": "198.51.100.20" },
    });

    expect(response.json()).toEqual({ ip: "203.0.113.10" });
  });

  it("accepts forwarded client addresses only from an allowlisted proxy", async () => {
    app = await createApp({ config: testConfig });
    app.get("/_test/client-ip", (request) => ({ ip: request.ip }));

    const response = await app.inject({
      method: "GET",
      url: "/_test/client-ip",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.20" },
    });

    expect(response.json()).toEqual({ ip: "198.51.100.20" });
  });
});
