export const TOOL_PERMISSIONS = [
  "system.echo",
  "utility.calculator",
  "utility.datetime",
  "calendar.events.read",
] as const;

export type ToolPermission = (typeof TOOL_PERMISSIONS)[number];
