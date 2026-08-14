export const TOOL_PERMISSIONS = [
  "system.echo",
  "utility.calculator",
  "utility.datetime",
  "calendar.events.read",
  "calendar.events.write",
] as const;

export type ToolPermission = (typeof TOOL_PERMISSIONS)[number];
