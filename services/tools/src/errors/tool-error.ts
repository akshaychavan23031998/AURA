export type ToolErrorCode =
  | "TOOL_NOT_FOUND"
  | "INVALID_TOOL_INPUT"
  | "PERMISSION_DENIED"
  | "APPROVAL_REQUIRED"
  | "TOOL_EXECUTION_FAILED"
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
