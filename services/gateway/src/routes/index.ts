import type { FastifyInstance, preHandlerHookHandler } from "fastify";

import { registerHealthRoutes } from "./health/health.route.js";
import type { ToolServiceClient } from "../clients/tools/tool-service-client.js";
import { registerToolExecutionRoute } from "./tools/tool-execution.route.js";
import type { AgentServiceClient } from "../clients/agent/agent-service-client.js";
import { registerAgentResponseRoute } from "./agent/agent-response.route.js";
import { registerAgentRunRoute } from "./agent/agent-run.route.js";
import type { AgentToolOrchestrator } from "../orchestration/agent-tool-orchestrator.js";
import type { SessionManager } from "../identity/session-service.js";
import { registerAuthRoutes } from "./auth/auth.route.js";
import type { VoiceTurnService } from "../orchestration/voice-turn-service.js";
import { registerVoiceRunRoute } from "./voice/voice-run.route.js";
import { registerVoiceSessionRoute } from "./voice/voice-session.route.js";
import type { GatewayConfig } from "../config/index.js";

export function registerRoutes(
  app: FastifyInstance,
  toolClient: ToolServiceClient,
  agentClient: AgentServiceClient,
  orchestrator: AgentToolOrchestrator,
  authenticate: preHandlerHookHandler,
  sessions: SessionManager,
  checkDatabase: () => Promise<void>,
  voiceTurns: VoiceTurnService,
  config?: GatewayConfig,
): void {
  registerHealthRoutes(app, checkDatabase);
  if (config !== undefined)
    registerAuthRoutes(app, sessions, authenticate, config);
  registerToolExecutionRoute(app, toolClient, authenticate);
  registerAgentResponseRoute(app, agentClient, authenticate);
  registerAgentRunRoute(app, orchestrator, authenticate);
  registerVoiceRunRoute(app, voiceTurns, authenticate);
  if (config !== undefined)
    registerVoiceSessionRoute(app, voiceTurns, authenticate, config);
}
