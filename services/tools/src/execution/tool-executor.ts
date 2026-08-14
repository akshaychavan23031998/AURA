import type { ToolSuccessResult } from "../domain/tool-result.js";
import { ToolError } from "../errors/tool-error.js";
import type { ToolRegistry } from "../registry/tool-registry.js";
import { hasValidApproval, requiresApproval } from "./approval-policy.js";
import type { ExecutionContext } from "../domain/tool-context.js";
import { actionDigest } from "./action-digest.js";

export interface ToolExecutionRequest {
  readonly tool: string;
  readonly version?: number;
  readonly input: unknown;
  readonly context: ExecutionContext;
}

export class ToolExecutor {
  public constructor(private readonly registry: ToolRegistry) {}

  public async execute(
    request: ToolExecutionRequest,
  ): Promise<ToolSuccessResult> {
    const tool = this.registry.resolve(request.tool, request.version ?? 1);
    const parsedInput = tool.inputSchema.safeParse(request.input);
    if (!parsedInput.success) {
      throw new ToolError("TOOL_INPUT_INVALID", 400, "Tool input is invalid");
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

    if (
      requiresApproval(tool) &&
      !hasValidApproval(tool, request.context, parsedInput.data)
    ) {
      throw new ToolError(
        "TOOL_APPROVAL_REQUIRED",
        409,
        "Trusted approval is required",
      );
    }

    try {
      const data = await withExecutionTimeout(
        tool.execute(parsedInput.data, request.context),
        tool.timeoutMs,
      );
      const parsedOutput = tool.outputSchema.safeParse(data);
      if (!parsedOutput.success) {
        throw new ToolError(
          "TOOL_OUTPUT_INVALID",
          500,
          "Tool output is invalid",
        );
      }
      return {
        status: "success",
        tool: tool.name,
        version: tool.version,
        data: parsedOutput.data,
      };
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(
        "TOOL_EXECUTION_FAILED",
        500,
        "Tool execution failed",
        { cause: error },
      );
    }
  }

  public prepare(toolName: string, version: number, input: unknown) {
    const tool = this.registry.resolve(toolName, version);
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ToolError("TOOL_INPUT_INVALID", 400, "Tool input is invalid");
    }
    return {
      tool: tool.name,
      version: tool.version,
      title: tool.title,
      approvalPolicy: requiresApproval(tool)
        ? ("REQUIRED" as const)
        : ("NONE" as const),
      input: parsed.data,
      inputDigest: actionDigest(tool.name, tool.version, parsed.data),
      preview: tool.title,
    };
  }
}

async function withExecutionTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new ToolError("TOOL_TIMEOUT", 504, "Tool execution timed out"),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
