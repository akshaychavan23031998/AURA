import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ToolServiceClient } from "../../clients/tools/tool-service-client.js";
import { deriveDevelopmentActorContext } from "../../context/development-actor.js";
import { AppError } from "../../errors/app-error.js";

const externalRequestSchema = z
  .object({
    tool: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/)
      .max(128),
    input: z.unknown(),
  })
  .strict();

export function registerToolExecutionRoute(
  app: FastifyInstance,
  toolClient: ToolServiceClient,
): void {
  app.post("/api/v1/tools/execute", async (request) => {
    const parsed = externalRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        httpStatus: 400,
        message: "Request validation failed",
      });
    }

    return toolClient.execute(
      parsed.data,
      deriveDevelopmentActorContext(),
      request.id,
    );
  });
}
