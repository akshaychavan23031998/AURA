import type { FastifyInstance } from "fastify";

import {
  healthResponseSchema,
  readinessResponseSchema,
} from "./health.schema.js";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get(
    "/health",
    { schema: { response: { 200: healthResponseSchema } } },
    () => ({ status: "ok", service: "gateway" }),
  );

  app.get(
    "/ready",
    { schema: { response: { 200: readinessResponseSchema } } },
    () => ({ status: "ready", service: "gateway" }),
  );
}
