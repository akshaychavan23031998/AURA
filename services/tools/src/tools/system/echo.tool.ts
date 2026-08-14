import { z } from "zod";

import type { ToolDefinition } from "../../registry/tool-definition.js";

const echoInputSchema = z.object({ message: z.string().max(4_096) }).strict();
type EchoInput = z.infer<typeof echoInputSchema>;

export const echoTool: ToolDefinition<EchoInput, EchoInput> = {
  name: "system.echo",
  version: 1,
  title: "Echo text",
  description:
    "Returns the supplied message unchanged. Intended for service-contract validation.",
  category: "system",
  inputSchema: echoInputSchema,
  outputSchema: echoInputSchema,
  requiredPermissions: ["system.echo"],
  riskLevel: "READ",
  approvalPolicy: "NONE",
  idempotency: "IDEMPOTENT",
  timeoutMs: 2_000,
  enabled: true,
  execute: (input) => Promise.resolve(input),
};
