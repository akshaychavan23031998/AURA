import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import { requirePrincipal } from "../../auth/auth-plugin.js";
import type { AllowedPermission } from "../../auth/principal.js";
import { AppError } from "../../errors/app-error.js";
import type { MemoryStore } from "../../memory/memory-service.js";

export const MEMORY_CONTENT_MAX_LENGTH = 4096;
const memoryKindSchema = z.enum(["preference", "fact", "instruction", "note"]);
const memoryIdSchema = z.uuid();
const createMemorySchema = z
  .object({
    kind: memoryKindSchema,
    content: z
      .string()
      .max(MEMORY_CONTENT_MAX_LENGTH)
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(1)
          .max(MEMORY_CONTENT_MAX_LENGTH)
          .refine((value) => !hasForbiddenControlCharacter(value)),
      ),
  })
  .strict();
const listMemorySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    kind: memoryKindSchema.optional(),
  })
  .strict();

export function registerMemoryRoutes(
  app: FastifyInstance,
  authenticate: preHandlerHookHandler,
  memories: MemoryStore,
): void {
  app.get("/api/v1/memories", { preHandler: authenticate }, async (request) => {
    const principal = requirePermission(request, "memory.read");
    const query = parse(listMemorySchema, request.query);
    return {
      memories: await memories.listOwned(
        principal.actorId,
        query.kind === undefined
          ? { limit: query.limit }
          : { limit: query.limit, kind: query.kind },
      ),
    };
  });

  app.get<{ Params: { memoryId: string } }>(
    "/api/v1/memories/:memoryId",
    { preHandler: authenticate },
    async (request) => {
      const principal = requirePermission(request, "memory.read");
      const memoryId = parse(memoryIdSchema, request.params.memoryId);
      return { memory: await memories.getOwned(principal.actorId, memoryId) };
    },
  );

  app.post(
    "/api/v1/memories",
    { preHandler: authenticate },
    async (request) => {
      const principal = requirePermission(request, "memory.write");
      const input = parse(createMemorySchema, request.body);
      return {
        memory: await memories.create(principal.actorId, input, request.id),
      };
    },
  );

  app.delete<{ Params: { memoryId: string } }>(
    "/api/v1/memories/:memoryId",
    { preHandler: authenticate },
    async (request, reply) => {
      const principal = requirePermission(request, "memory.write");
      const memoryId = parse(memoryIdSchema, request.params.memoryId);
      await memories.deleteOwned(principal.actorId, memoryId);
      return reply.status(204).send();
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
  if (!parsed.success)
    throw new AppError({
      code: "MEMORY_INPUT_INVALID",
      httpStatus: 400,
      message: "Memory input is invalid",
    });
  return parsed.data;
}

function hasForbiddenControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
    );
  });
}
