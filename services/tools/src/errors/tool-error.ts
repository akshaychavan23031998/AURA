export type ToolErrorCode =
  | "TOOL_NOT_FOUND"
  | "TOOL_DISABLED"
  | "TOOL_VERSION_UNSUPPORTED"
  | "TOOL_INPUT_INVALID"
  | "TOOL_OUTPUT_INVALID"
  | "PERMISSION_DENIED"
  | "TOOL_APPROVAL_REQUIRED"
  | "TOOL_EXECUTION_FAILED"
  | "TOOL_TIMEOUT"
  | "CALCULATION_INVALID"
  | "INTERNAL_SERVICE_UNAUTHORIZED"
  | "ROUTE_NOT_FOUND"
  | "VALIDATION_ERROR"
  | "INTERNAL_SERVER_ERROR";

export class ToolError extends Error {
  public constructor(
    public readonly code: ToolErrorCode,
    public readonly httpStatus: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolError";
  }
}
