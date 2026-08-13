import { timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import type { ToolsConfig } from "../config/index.js";
import { ToolError } from "../errors/tool-error.js";

export const INTERNAL_SERVICE_ID_HEADER = "x-aura-service-id";
export const INTERNAL_SERVICE_TOKEN_HEADER = "x-aura-service-token";

function secretsMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function createInternalAuthGuard(config: ToolsConfig) {
  return (
    request: FastifyRequest,
    _reply: FastifyReply,
    done: (error?: Error) => void,
  ): void => {
    const serviceId = request.headers[INTERNAL_SERVICE_ID_HEADER];
    const token = request.headers[INTERNAL_SERVICE_TOKEN_HEADER];
    const valid =
      serviceId === config.internalAuth.allowedServiceId &&
      typeof token === "string" &&
      secretsMatch(token, config.internalAuth.token);

    if (!valid) {
      done(
        new ToolError(
          "INTERNAL_SERVICE_UNAUTHORIZED",
          401,
          "Internal service authentication failed",
        ),
      );
      return;
    }

    done();
  };
}
