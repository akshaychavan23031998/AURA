import type { z } from "zod";

import type { ExecutionContext } from "../domain/tool-context.js";
import type { ToolPermission } from "../domain/tool-permission.js";
import type { ToolRisk } from "../domain/tool-risk.js";

export interface ToolDefinition<Input, Output> {
  readonly name: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly category: "system" | "utility" | "productivity";
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  readonly requiredPermissions: readonly ToolPermission[];
  readonly riskLevel: ToolRisk;
  readonly approvalPolicy: "NONE" | "REQUIRED";
  readonly idempotency: "IDEMPOTENT" | "NON_IDEMPOTENT";
  readonly timeoutMs: number;
  readonly enabled: boolean;
  readonly approvalPreview?: (input: unknown) => string;
  execute(input: Input, context: ExecutionContext): Promise<Output>;
}

export type RegisteredTool = ToolDefinition<unknown, unknown>;

export interface ToolMetadata {
  readonly name: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly category: "system" | "utility" | "productivity";
  readonly requiredPermissions: readonly string[];
  readonly riskLevel: ToolRisk;
  readonly approvalPolicy: "NONE" | "REQUIRED";
  readonly idempotency: "IDEMPOTENT" | "NON_IDEMPOTENT";
  readonly timeoutMs: number;
  readonly enabled: boolean;
}

export interface AgentToolCapability {
  readonly name: string;
  readonly description: string;
  readonly category: "system" | "utility" | "productivity";
  readonly inputSchema: unknown;
}
