import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { AppError } from "../../errors/app-error.js";
import type { AgentToolOrchestrator } from "../../orchestration/agent-tool-orchestrator.js";

const requestSchema = z
  .object({
    message: z.string().trim().min(1).max(8192),
    conversationId: z.string().min(1).max(128).optional(),
    locale: z
      .string()
      .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
      .max(35)
      .optional(),
  })
  .strict();

export function registerAgentRunRoute(
  app: FastifyInstance,
  orchestrator: AgentToolOrchestrator,
): void {
  app.post("/api/v1/agent/run", async (request) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        httpStatus: 400,
        message: "Request validation failed",
      });
    }
    const runRequest = {
      message: parsed.data.message,
      ...(parsed.data.conversationId === undefined
        ? {}
        : { conversationId: parsed.data.conversationId }),
      ...(parsed.data.locale === undefined
        ? {}
        : { locale: parsed.data.locale }),
    };
    return orchestrator.run(runRequest, request.id);
  });
}
