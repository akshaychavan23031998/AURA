import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ToolServiceClient } from "../../clients/tools/tool-service-client.js";
import { deriveAuthorizationContext } from "../../auth/authorization-context.js";
import { requirePrincipal } from "../../auth/auth-plugin.js";
import type { preHandlerHookHandler } from "fastify";
import { AppError } from "../../errors/app-error.js";
import type { ApprovalRepository } from "../../approvals/approval-repository.js";

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
  authenticate: preHandlerHookHandler,
  approvals?: ApprovalRepository,
  approvalTtlSeconds = 300,
): void {
  app.post(
    "/api/v1/tools/execute",
    { preHandler: authenticate },
    async (request) => {
      const parsed = externalRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          httpStatus: 400,
          message: "Request validation failed",
        });
      }

      const principal = requirePrincipal(request);
      const preparation = await toolClient.prepare?.(parsed.data, request.id);
      if (preparation?.approvalPolicy === "REQUIRED") {
        if (approvals === undefined)
          throw new AppError({
            code: "INTERNAL_SERVER_ERROR",
            httpStatus: 500,
            message: "Approval service unavailable",
          });
        const approval = await approvals.create({
          actorId: principal.actorId,
          toolName: preparation.tool,
          toolVersion: preparation.version,
          inputDigest: preparation.inputDigest,
          input: preparation.input,
          request: {},
          title: preparation.title,
          preview: preparation.preview,
          expiresAt: new Date(Date.now() + approvalTtlSeconds * 1_000),
        });
        return {
          status: "approval_required",
          approval: {
            approvalId: approval.id,
            toolName: approval.toolName,
            toolVersion: approval.toolVersion,
            title: approval.title,
            preview: approval.preview,
            status: approval.status,
            expiresAt: approval.expiresAt.toISOString(),
          },
        };
      }
      return toolClient.execute(
        parsed.data,
        deriveAuthorizationContext(principal),
        request.id,
      );
    },
  );
}
