import { z } from "zod";

import type { ToolDefinition } from "../../registry/tool-definition.js";

const echoInputSchema = z.object({ message: z.string().max(4_096) }).strict();
type EchoInput = z.infer<typeof echoInputSchema>;

export const echoTool: ToolDefinition<EchoInput, EchoInput> = {
  name: "system.echo",
  description:
    "Returns the supplied message unchanged. Intended for service-contract validation.",
  inputSchema: echoInputSchema,
  requiredPermissions: ["system.echo"],
  riskLevel: "READ",
  requiresApproval: false,
  execute: (input) => Promise.resolve(input),
};
