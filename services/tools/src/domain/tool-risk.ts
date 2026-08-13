export const TOOL_RISKS = ["READ", "WRITE", "DESTRUCTIVE"] as const;
export type ToolRisk = (typeof TOOL_RISKS)[number];
