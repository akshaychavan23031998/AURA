import type { ToolSuccessResult } from "../domain/tool-result.js";
import { ToolError } from "../errors/tool-error.js";
import type { ToolRegistry } from "../registry/tool-registry.js";
import { hasValidApproval, requiresApproval } from "./approval-policy.js";
import type { ExecutionContext } from "../domain/tool-context.js";

export interface ToolExecutionRequest {
  readonly tool: string;
  readonly input: unknown;
  readonly context: ExecutionContext;
}

export class ToolExecutor {
  public constructor(private readonly registry: ToolRegistry) {}

  public async execute(
    request: ToolExecutionRequest,
  ): Promise<ToolSuccessResult> {
    const tool = this.registry.get(request.tool);
    const parsedInput = tool.inputSchema.safeParse(request.input);
    if (!parsedInput.success) {
      throw new ToolError("INVALID_TOOL_INPUT", 400, "Tool input is invalid");
    }

    const granted = new Set(request.context.grantedPermissions);
    if (
      tool.requiredPermissions.some((permission) => !granted.has(permission))
    ) {
      throw new ToolError(
        "PERMISSION_DENIED",
        403,
        "Required tool permission is missing",
      );
    }

    if (requiresApproval(tool) && !hasValidApproval(tool, request.context)) {
      throw new ToolError(
        "APPROVAL_REQUIRED",
        409,
        "Trusted approval is required",
      );
    }

    try {
      const data = await tool.execute(parsedInput.data, request.context);
      return { status: "success", tool: tool.name, data };
    } catch (error) {
      throw new ToolError(
        "TOOL_EXECUTION_FAILED",
        500,
        "Tool execution failed",
        { cause: error },
      );
    }
  }
}
