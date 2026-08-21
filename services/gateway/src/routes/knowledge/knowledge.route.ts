import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import { requirePrincipal } from "../../auth/auth-plugin.js";
import type { AllowedPermission } from "../../auth/principal.js";
import { AppError } from "../../errors/app-error.js";
import {
  KNOWLEDGE_FILE_MAX_BYTES,
  extractKnowledgeFile,
} from "../../knowledge/knowledge-file-extractor.js";
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
const searchKnowledgeSchema = z
  .object({
    query: z
      .string()
      .max(1024)
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(1)
          .max(1024)
          .refine((value) => !hasUnsafeContentCharacter(value)),
      ),
  })
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

  app.post(
    "/api/v1/knowledge/files",
    { preHandler: authenticate, bodyLimit: KNOWLEDGE_FILE_MAX_BYTES + 65_536 },
    async (request, reply) => {
      const principal = requirePermission(request, "knowledge.write");
      if (!request.isMultipart()) throw fileInvalid();
      let upload:
        { filename: string; contentType: string; bytes: Buffer } | undefined;
      try {
        for await (const part of request.parts({
          limits: { files: 1, fields: 0, fileSize: KNOWLEDGE_FILE_MAX_BYTES },
        })) {
          if (part.type !== "file" || part.fieldname !== "file" || upload)
            throw fileInvalid();
          const bytes = await part.toBuffer();
          if (part.file.truncated) throw fileTooLarge();
          upload = {
            filename: part.filename,
            contentType: part.mimetype,
            bytes,
          };
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "FST_REQ_FILE_TOO_LARGE"
        )
          throw fileTooLarge();
        throw fileInvalid();
      }
      if (upload === undefined) throw fileInvalid();
      const extracted = await extractKnowledgeFile(upload);
      const document = await knowledge.create(
        principal.actorId,
        extracted,
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

  app.post(
    "/api/v1/knowledge/search",
    { preHandler: authenticate },
    async (request) => {
      const principal = requirePermission(request, "knowledge.read");
      const input = parse(searchKnowledgeSchema, request.body);
      return {
        results: await knowledge.searchOwned(
          principal.actorId,
          input.query,
          request.id,
        ),
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

function fileInvalid(): AppError {
  return new AppError({
    code: "KNOWLEDGE_FILE_INVALID",
    httpStatus: 400,
    message: "Knowledge file is invalid",
  });
}

function fileTooLarge(): AppError {
  return new AppError({
    code: "KNOWLEDGE_FILE_TOO_LARGE",
    httpStatus: 413,
    message: "Knowledge file is too large",
  });
}
