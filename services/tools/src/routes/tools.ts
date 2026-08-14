import { performance } from "node:perf_hooks";

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import type { ToolExecutor } from "../execution/tool-executor.js";
import { ToolError } from "../errors/tool-error.js";
import type { ToolRegistry } from "../registry/tool-registry.js";

const approvalSchema = z
  .object({
    status: z.literal("approved"),
    approvalId: z.string().min(1).max(128),
    approvedActorId: z.string().min(1).max(128),
    approvedTool: z.string().min(1).max(128),
    approvedToolVersion: z.number().int().positive(),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const executionRequestSchema = z
  .object({
    tool: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/)
      .max(128),
    version: z.number().int().positive().default(1),
    input: z.unknown(),
    context: z
      .object({
        actorId: z.string().min(1).max(128),
        conversationId: z.string().min(1).max(128).optional(),
        grantedPermissions: z.array(z.string().min(1).max(128)).max(100),
        approval: approvalSchema.optional(),
        idempotencyKey: z.string().min(1).max(256).optional(),
        providerAccessToken: z.string().min(16).max(4096).optional(),
      })
      .strict(),
  })
  .strict();

const prepareRequestSchema = executionRequestSchema
  .pick({ tool: true, version: true, input: true })
  .extend({
    context: z
      .object({
        actorId: z.string().min(1).max(128),
        grantedPermissions: z.array(z.string().min(1).max(128)).max(100),
      })
      .strict(),
  })
  .strict();

export interface ToolRouteDependencies {
  readonly registry: ToolRegistry;
  readonly executor: ToolExecutor;
  readonly internalAuth: preHandlerHookHandler;
}

export function registerToolRoutes(
  app: FastifyInstance,
  dependencies: ToolRouteDependencies,
): void {
  app.get("/tools", { preHandler: dependencies.internalAuth }, () => ({
    tools: dependencies.registry.listMetadata(),
  }));
  app.get(
    "/tools/catalog/agent",
    { preHandler: dependencies.internalAuth },
    () => ({
      tools: dependencies.registry.listAgentCapabilities(),
    }),
  );
  app.post(
    "/tools/prepare",
    { preHandler: dependencies.internalAuth },
    (request) => {
      const parsed = prepareRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ToolError(
          "VALIDATION_ERROR",
          400,
          "Request validation failed",
        );
      }
      return dependencies.executor.prepare(
        parsed.data.tool,
        parsed.data.version,
        parsed.data.input,
        parsed.data.context,
      );
    },
  );

  app.post(
    "/tools/execute",
    { preHandler: dependencies.internalAuth },
    async (request) => {
      const parsed = executionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ToolError(
          "VALIDATION_ERROR",
          400,
          "Request validation failed",
        );
      }

      const startedAt = performance.now();
      const tool = dependencies.registry.resolve(
        parsed.data.tool,
        parsed.data.version,
      );
      try {
        const context = {
          requestId: request.id,
          actorId: parsed.data.context.actorId,
          grantedPermissions: parsed.data.context.grantedPermissions,
          ...(parsed.data.context.conversationId === undefined
            ? {}
            : { conversationId: parsed.data.context.conversationId }),
          ...(parsed.data.context.approval === undefined
            ? {}
            : { approval: parsed.data.context.approval }),
          ...(parsed.data.context.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: parsed.data.context.idempotencyKey }),
          ...(parsed.data.context.providerAccessToken === undefined
            ? {}
            : {
                providerAccessToken: parsed.data.context.providerAccessToken,
              }),
        };
        const result = await dependencies.executor.execute({
          tool: parsed.data.tool,
          version: parsed.data.version,
          input: parsed.data.input,
          context,
        });
        request.log.info(
          {
            tool: tool.name,
            riskLevel: tool.riskLevel,
            executionStatus: "success",
            callerService: "gateway",
            duration: performance.now() - startedAt,
          },
          "Tool execution completed",
        );
        return result;
      } catch (error) {
        request.log.warn(
          {
            tool: tool.name,
            riskLevel: tool.riskLevel,
            executionStatus: "failed",
            callerService: "gateway",
            duration: performance.now() - startedAt,
          },
          "Tool execution rejected or failed",
        );
        throw error;
      }
    },
  );
}
