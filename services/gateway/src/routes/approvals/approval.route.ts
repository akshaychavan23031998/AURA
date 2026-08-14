import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { requirePrincipal } from "../../auth/auth-plugin.js";
import type { ToolServiceClient } from "../../clients/tools/tool-service-client.js";
import type { ApprovalRepository } from "../../approvals/approval-repository.js";
import { AppError } from "../../errors/app-error.js";
import type { AgentToolOrchestrator } from "../../orchestration/agent-tool-orchestrator.js";
import type { ApprovalRealtimeRegistry } from "../../approvals/approval-realtime-registry.js";

const paramsSchema = z.object({ approvalId: z.string().uuid() }).strict();
const decisionBodySchema = z.union([
  z.undefined(),
  z.null(),
  z.object({}).strict(),
]);
const continuationSchema = z
  .object({
    kind: z.literal("agent_tool"),
    request: z
      .object({
        message: z.string(),
        conversationId: z.string().optional(),
        locale: z.string().optional(),
      })
      .strict(),
    originalRequestId: z.string(),
  })
  .strict();

export function registerApprovalRoutes(
  app: FastifyInstance,
  approvals: ApprovalRepository,
  tools: ToolServiceClient,
  authenticate: preHandlerHookHandler,
  orchestrator?: AgentToolOrchestrator,
  realtime?: ApprovalRealtimeRegistry,
): void {
  app.get(
    "/api/v1/approvals/:approvalId",
    { preHandler: authenticate },
    async (request) => {
      const params = paramsSchema.parse(request.params);
      const row = await approvals.findOwned(
        params.approvalId,
        requirePrincipal(request).actorId,
      );
      if (!row) throw approvalError("APPROVAL_NOT_FOUND", 404);
      return publicApproval(row);
    },
  );
  app.post(
    "/api/v1/approvals/:approvalId/reject",
    { preHandler: authenticate },
    async (request) => {
      validateDecisionBody(request.body);
      const params = paramsSchema.parse(request.params);
      const row = await approvals.reject(
        params.approvalId,
        requirePrincipal(request).actorId,
        new Date(),
      );
      if (!row) throw approvalError("APPROVAL_NOT_PENDING", 409);
      realtime?.rejected(row.id);
      return publicApproval(row);
    },
  );
  app.post(
    "/api/v1/approvals/:approvalId/approve",
    { preHandler: authenticate },
    async (request) => {
      validateDecisionBody(request.body);
      const params = paramsSchema.parse(request.params);
      const principal = requirePrincipal(request);
      const row = await approvals.consume(
        params.approvalId,
        principal.actorId,
        new Date(),
      );
      if (!row) throw approvalError("APPROVAL_NOT_PENDING", 409);
      const context = {
        actorId: principal.actorId,
        grantedPermissions: principal.permissions,
        approval: {
          status: "approved",
          approvalId: row.id,
          approvedActorId: principal.actorId,
          approvedTool: row.toolName,
          approvedToolVersion: row.toolVersion,
          inputDigest: row.inputDigest,
        },
      } as const;
      const continuation = continuationSchema.safeParse(row.requestEnvelope);
      if (continuation.success && orchestrator !== undefined) {
        try {
          const result = await orchestrator.resumeApproved(
            {
              message: continuation.data.request.message,
              ...(continuation.data.request.conversationId === undefined
                ? {}
                : {
                    conversationId: continuation.data.request.conversationId,
                  }),
              ...(continuation.data.request.locale === undefined
                ? {}
                : { locale: continuation.data.request.locale }),
            },
            { name: row.toolName, input: row.inputEnvelope },
            context,
            continuation.data.originalRequestId,
          );
          realtime?.approved(row.id, result.response.text);
          return { approval: publicApproval(row), result };
        } catch (error) {
          realtime?.failed(row.id);
          throw error;
        }
      }
      const result = await tools.execute(
        { tool: row.toolName, input: row.inputEnvelope },
        context,
        request.id,
      );
      return { approval: publicApproval(row), result };
    },
  );
}

function publicApproval(row: {
  id: string;
  toolName: string;
  toolVersion: number;
  title: string;
  preview: string;
  status: string;
  expiresAt: Date;
}) {
  return {
    approvalId: row.id,
    toolName: row.toolName,
    toolVersion: row.toolVersion,
    title: row.title,
    preview: row.preview,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
  };
}
function approvalError(code: string, httpStatus: number) {
  return new AppError({
    code,
    httpStatus,
    message: "Approval request is unavailable",
  });
}

function validateDecisionBody(body: unknown): void {
  if (!decisionBodySchema.safeParse(body).success)
    throw new AppError({
      code: "VALIDATION_ERROR",
      httpStatus: 400,
      message: "Approval decisions do not accept action metadata",
    });
}
