import type { FastifyInstance } from "fastify";

import {
  healthResponseSchema,
  readinessResponseSchema,
} from "./health.schema.js";

export function registerHealthRoutes(
  app: FastifyInstance,
  checkDatabase: () => Promise<void>,
): void {
  app.get(
    "/health",
    { schema: { response: { 200: healthResponseSchema } } },
    () => ({ status: "ok", service: "gateway" }),
  );

  app.get(
    "/ready",
    { schema: { response: { 200: readinessResponseSchema } } },
    async () => {
      await checkDatabase();
      return { status: "ready", service: "gateway" };
    },
  );
}
