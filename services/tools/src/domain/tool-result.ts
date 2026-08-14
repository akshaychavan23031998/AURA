export interface ToolSuccessResult {
  readonly status: "success";
  readonly tool: string;
  readonly version: number;
  readonly data: unknown;
}
