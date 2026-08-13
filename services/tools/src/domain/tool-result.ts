export interface ToolSuccessResult {
  readonly status: "success";
  readonly tool: string;
  readonly data: unknown;
}
