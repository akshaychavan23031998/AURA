import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import { requirePrincipal } from "../../auth/auth-plugin.js";
import type { AllowedPermission } from "../../auth/principal.js";
import { AppError } from "../../errors/app-error.js";
import type { KnowledgeStore } from "../../knowledge/knowledge-service.js";
import { KNOWLEDGE_CONTENT_MAX_BYTES } from "../../knowledge/text-normalizer.js";

const documentIdSchema = z.uuid();
const createDocumentSchema = z
  .object({
    title: z
      .string()
      .max(200)
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(1)
          .max(200)
          .refine((value) => !hasUnsafeTitleCharacter(value)),
      ),
    content: z
      .string()
      .max(131_072)
      .refine((value) => value.trim().length > 0)
      .refine((value) => !hasUnsafeContentCharacter(value)),
  })
  .strict();
const listDocumentSchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  authenticate: preHandlerHookHandler,
  knowledge: KnowledgeStore,
): void {
  app.post(
    "/api/v1/knowledge/documents",
    {
      preHandler: authenticate,
      bodyLimit: KNOWLEDGE_CONTENT_MAX_BYTES * 4 + 4096,
    },
    async (request, reply) => {
      const principal = requirePermission(request, "knowledge.write");
      const input = parse(createDocumentSchema, request.body);
      const document = await knowledge.create(
        principal.actorId,
        input,
        request.id,
      );
      return reply.status(201).send({ document });
    },
  );

  app.get(
    "/api/v1/knowledge/documents",
    { preHandler: authenticate },
    async (request) => {
      const principal = requirePermission(request, "knowledge.read");
      const query = parse(listDocumentSchema, request.query);
      return {
        documents: await knowledge.listOwned(principal.actorId, query.limit),
      };
    },
  );

  app.get<{ Params: { documentId: string } }>(
    "/api/v1/knowledge/documents/:documentId",
    { preHandler: authenticate },
    async (request) => {
      const principal = requirePermission(request, "knowledge.read");
      const documentId = parse(documentIdSchema, request.params.documentId);
      return {
        document: await knowledge.getOwned(principal.actorId, documentId),
      };
    },
  );

  app.delete<{ Params: { documentId: string } }>(
    "/api/v1/knowledge/documents/:documentId",
    { preHandler: authenticate },
    async (request, reply) => {
      const principal = requirePermission(request, "knowledge.write");
      const documentId = parse(documentIdSchema, request.params.documentId);
      await knowledge.deleteOwned(principal.actorId, documentId, request.id);
      return reply.status(204).send();
    },
  );
}

function hasUnsafeTitleCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code <= 159);
  });
}

function hasUnsafeContentCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      (code >= 127 && code <= 159)
    );
  });
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
  if (!parsed.success)
    throw new AppError({
      code: "KNOWLEDGE_INPUT_INVALID",
      httpStatus: 400,
      message: "Knowledge input is invalid",
    });
  return parsed.data;
}
