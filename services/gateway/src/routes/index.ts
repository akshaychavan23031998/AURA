import type { FastifyInstance } from "fastify";

import { registerHealthRoutes } from "./health/health.route.js";
import type { ToolServiceClient } from "../clients/tools/tool-service-client.js";
import { registerToolExecutionRoute } from "./tools/tool-execution.route.js";

export function registerRoutes(
  app: FastifyInstance,
  toolClient: ToolServiceClient,
): void {
  app.register(registerHealthRoutes);
  registerToolExecutionRoute(app, toolClient);
}
