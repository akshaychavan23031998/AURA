import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import type { ToolsConfig } from "../config/index.js";
import { registerErrorHandling } from "../errors/error-handler.js";
import { ToolExecutor } from "../execution/tool-executor.js";
import {
  registerRequestContext,
  resolveRequestId,
} from "../plugins/request-context.js";
import {
  createInternalAuthGuard,
  INTERNAL_SERVICE_TOKEN_HEADER,
} from "../plugins/internal-auth.js";
import { registerSecurity } from "../plugins/security.js";
import { createToolRegistry } from "../registry/create-registry.js";
import type { ToolRegistry } from "../registry/tool-registry.js";
import { registerHealthRoutes } from "../routes/health.js";
import { registerToolRoutes } from "../routes/tools.js";

export interface CreateAppOptions {
  readonly config: ToolsConfig;
  readonly logger?: FastifyServerOptions["logger"];
  readonly registry?: ToolRegistry;
}

export async function createApp(
  options: CreateAppOptions,
): Promise<FastifyInstance> {
  const serverOptions: FastifyServerOptions = {
    logger:
      options.logger ??
      ({
        level: options.config.logging.level,
        base: {
          service: "tools",
          environment: options.config.runtime.environment,
        },
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            `req.headers.${INTERNAL_SERVICE_TOKEN_HEADER}`,
            "req.body",
            "*.token",
            "*.secret",
          ],
          censor: "[REDACTED]",
        },
      } satisfies FastifyServerOptions["logger"]),
    genReqId: resolveRequestId,
    bodyLimit: options.config.server.bodyLimit,
  };
  const app = Fastify(serverOptions);
  const registry = options.registry ?? createToolRegistry();

  await registerSecurity(app);
  registerRequestContext(app);
  registerHealthRoutes(app);
  registerToolRoutes(app, {
    registry,
    executor: new ToolExecutor(registry),
    internalAuth: createInternalAuthGuard(options.config),
  });
  registerErrorHandling(app);
  return app;
}
