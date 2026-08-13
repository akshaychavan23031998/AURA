export const healthResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "service"],
  properties: {
    status: { type: "string", const: "ok" },
    service: { type: "string", const: "gateway" },
  },
} as const;

export const readinessResponseSchema = {
  ...healthResponseSchema,
  properties: {
    status: { type: "string", const: "ready" },
    service: { type: "string", const: "gateway" },
  },
} as const;
