import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import type { GatewayConfig } from "../config/index.js";
import {
  createAgentServiceClient,
  INTERNAL_SERVICE_TOKEN_HEADER,
  type AgentServiceClient,
} from "../clients/agent/agent-service-client.js";
import {
  createToolServiceClient,
  TOOL_SERVICE_TOKEN_HEADER,
  type ToolServiceClient,
} from "../clients/tools/tool-service-client.js";
import { registerErrorHandling } from "../errors/error-handler.js";
import {
  registerRequestContext,
  resolveRequestId,
} from "../plugins/request-context.js";
import { registerSecurity } from "../plugins/security.js";
import { registerRoutes } from "../routes/index.js";
import { deriveDevelopmentActorContext } from "../context/development-actor.js";
import { AgentToolOrchestrator } from "../orchestration/agent-tool-orchestrator.js";

export interface CreateAppOptions {
  readonly config: GatewayConfig;
  readonly logger?: FastifyServerOptions["logger"];
  readonly toolClient?: ToolServiceClient;
  readonly agentClient?: AgentServiceClient;
}

export async function createApp(
  options: CreateAppOptions,
): Promise<FastifyInstance> {
  const serverOptions: FastifyServerOptions = {
    logger:
      options.logger ??
      ({
        level: options.config.logging.level,
        base: { service: "gateway" },
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            `req.headers.${TOOL_SERVICE_TOKEN_HEADER}`,
            `req.headers.${INTERNAL_SERVICE_TOKEN_HEADER}`,
          ],
          censor: "[REDACTED]",
        },
      } satisfies FastifyServerOptions["logger"]),
    genReqId: resolveRequestId,
    bodyLimit: options.config.server.bodyLimit,
  };
  const app = Fastify(serverOptions);
  const toolClient =
    options.toolClient ??
    createToolServiceClient(options.config, fetch, app.log);
  const agentClient =
    options.agentClient ??
    createAgentServiceClient(options.config, fetch, app.log);

  await registerSecurity(app);
  registerRequestContext(app);
  registerRoutes(
    app,
    toolClient,
    agentClient,
    new AgentToolOrchestrator({
      agentClient,
      toolClient,
      actorContextProvider: deriveDevelopmentActorContext,
      logger: app.log,
    }),
  );
  registerErrorHandling(app);

  return app;
}
