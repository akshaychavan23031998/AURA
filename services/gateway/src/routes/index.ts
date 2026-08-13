import type { FastifyInstance } from "fastify";

import { registerHealthRoutes } from "./health/health.route.js";

export function registerRoutes(app: FastifyInstance): void {
  app.register(registerHealthRoutes);
}
