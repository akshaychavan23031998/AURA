import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import type { GatewayConfig } from "../config/index.js";

export async function registerSecurity(
  app: FastifyInstance,
  config: GatewayConfig,
): Promise<void> {
  await app.register(cors, {
    origin: config.browser.origin,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "x-request-id"],
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
  });
}
