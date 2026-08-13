import type { FastifyInstance } from "fastify";

import { registerHealthRoutes } from "./health/health.route.js";
import type { ToolServiceClient } from "../clients/tools/tool-service-client.js";
import { registerToolExecutionRoute } from "./tools/tool-execution.route.js";
import type { AgentServiceClient } from "../clients/agent/agent-service-client.js";
import { registerAgentResponseRoute } from "./agent/agent-response.route.js";
import { registerAgentRunRoute } from "./agent/agent-run.route.js";
import type { AgentToolOrchestrator } from "../orchestration/agent-tool-orchestrator.js";

export function registerRoutes(
  app: FastifyInstance,
  toolClient: ToolServiceClient,
  agentClient: AgentServiceClient,
  orchestrator: AgentToolOrchestrator,
): void {
  app.register(registerHealthRoutes);
  registerToolExecutionRoute(app, toolClient);
  registerAgentResponseRoute(app, agentClient);
  registerAgentRunRoute(app, orchestrator);
}
