import type { z } from "zod";

import type { ExecutionContext } from "../domain/tool-context.js";
import type { ToolPermission } from "../domain/tool-permission.js";
import type { ToolRisk } from "../domain/tool-risk.js";

export interface ToolDefinition<Input, Output> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly requiredPermissions: readonly ToolPermission[];
  readonly riskLevel: ToolRisk;
  readonly requiresApproval: boolean;
  execute(input: Input, context: ExecutionContext): Promise<Output>;
}

export type RegisteredTool = ToolDefinition<unknown, unknown>;

export interface ToolMetadata {
  readonly name: string;
  readonly description: string;
  readonly requiredPermissions: readonly string[];
  readonly riskLevel: ToolRisk;
  readonly requiresApproval: boolean;
}
