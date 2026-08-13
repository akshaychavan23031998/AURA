import type { FastifyInstance } from "fastify";

const responseSchema = (status: "ok" | "ready") =>
  ({
    type: "object",
    additionalProperties: false,
    required: ["status", "service"],
    properties: {
      status: { type: "string", const: status },
      service: { type: "string", const: "tools" },
    },
  }) as const;

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get(
    "/health",
    { schema: { response: { 200: responseSchema("ok") } } },
    () => ({
      status: "ok",
      service: "tools",
    }),
  );
  app.get(
    "/ready",
    { schema: { response: { 200: responseSchema("ready") } } },
    () => ({
      status: "ready",
      service: "tools",
    }),
  );
}
