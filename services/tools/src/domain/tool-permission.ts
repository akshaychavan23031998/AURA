export const TOOL_PERMISSIONS = [
  "system.echo",
  "utility.calculator",
  "utility.datetime",
  "calendar.events.read",
  "calendar.events.write",
  "gmail.messages.read",
  "gmail.messages.send",
] as const;

export type ToolPermission = (typeof TOOL_PERMISSIONS)[number];
