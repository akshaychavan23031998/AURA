import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import { requirePrincipal } from "../../auth/auth-plugin.js";
import type { AllowedPermission } from "../../auth/principal.js";
import { AppError } from "../../errors/app-error.js";
import type { WorkflowStore } from "../../workflows/workflow-service.js";
import type { WorkflowRunner } from "../../workflows/workflow-executor.js";
import { deriveAuthorizationContext } from "../../auth/authorization-context.js";

const workflowIdSchema = z.uuid();
const listSchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();

export function registerWorkflowRoutes(
  app: FastifyInstance,
  authenticate: preHandlerHookHandler,
  workflows: WorkflowStore,
  runner: WorkflowRunner,
): void {
  app.get(
    "/api/v1/workflows",
    { preHandler: authenticate },
    async (request) => {
      const principal = requirePermission(request, "workflow.read");
      const query = parse(listSchema, request.query);
      return {
        workflows: await workflows.listOwned(principal.actorId, query.limit),
      };
    },
  );

  app.get<{ Params: { workflowId: string } }>(
    "/api/v1/workflows/:workflowId",
    { preHandler: authenticate },
    async (request) => {
      const principal = requirePermission(request, "workflow.read");
      return {
        workflow: await workflows.getOwned(
          principal.actorId,
          parse(workflowIdSchema, request.params.workflowId),
        ),
      };
    },
  );

  app.post<{ Params: { workflowId: string } }>(
    "/api/v1/workflows/:workflowId/run",
    { preHandler: authenticate },
    async (request) => {
      const principal = requirePermission(request, "workflow.write");
      if (
        request.body != null &&
        (typeof request.body !== "object" ||
          Object.keys(request.body).length !== 0)
      )
        throw inputInvalid();
      return {
        workflow: await runner.run(
          principal.actorId,
          parse(workflowIdSchema, request.params.workflowId),
          deriveAuthorizationContext(principal),
          request.id,
        ),
      };
    },
  );

  app.post<{ Params: { workflowId: string } }>(
    "/api/v1/workflows/:workflowId/cancel",
    { preHandler: authenticate },
    async (request) => {
      const principal = requirePermission(request, "workflow.write");
      if (
        request.body != null &&
        (typeof request.body !== "object" ||
          Object.keys(request.body).length !== 0)
      )
        throw inputInvalid();
      return {
        workflow: await workflows.cancelOwned(
          principal.actorId,
          parse(workflowIdSchema, request.params.workflowId),
        ),
      };
    },
  );
}

function requirePermission(
  request: Parameters<typeof requirePrincipal>[0],
  permission: AllowedPermission,
) {
  const principal = requirePrincipal(request);
  if (!principal.permissions.includes(permission))
    throw new AppError({
      code: "PERMISSION_DENIED",
      httpStatus: 403,
      message: "Permission denied",
    });
  return principal;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw inputInvalid();
  return parsed.data;
}
function inputInvalid() {
  return new AppError({
    code: "WORKFLOW_INPUT_INVALID",
    httpStatus: 400,
    message: "Workflow input is invalid",
  });
}
