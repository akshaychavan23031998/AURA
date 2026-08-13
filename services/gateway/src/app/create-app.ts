import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import type { GatewayConfig } from "../config/index.js";
import { registerErrorHandling } from "../errors/error-handler.js";
import {
  registerRequestContext,
  resolveRequestId,
} from "../plugins/request-context.js";
import { registerSecurity } from "../plugins/security.js";
import { registerRoutes } from "../routes/index.js";

export interface CreateAppOptions {
  readonly config: GatewayConfig;
  readonly logger?: FastifyServerOptions["logger"];
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
          paths: ["req.headers.authorization", "req.headers.cookie"],
          censor: "[REDACTED]",
        },
      } satisfies FastifyServerOptions["logger"]),
    genReqId: resolveRequestId,
  };
  const app = Fastify(serverOptions);

  await registerSecurity(app);
  registerRequestContext(app);
  registerRoutes(app);
  registerErrorHandling(app);

  return app;
}
