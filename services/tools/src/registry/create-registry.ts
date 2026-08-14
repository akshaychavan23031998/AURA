import { echoTool } from "../tools/system/echo.tool.js";
import { calculatorTool } from "../tools/utility/calculator.tool.js";
import { datetimeTool } from "../tools/utility/datetime.tool.js";
import { ToolRegistry } from "./tool-registry.js";
import { createGoogleCalendarClient } from "../providers/google-calendar-client.js";
import { createCalendarTools } from "../tools/calendar/events.tool.js";

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  registry.register(calculatorTool);
  registry.register(datetimeTool);
  for (const tool of createCalendarTools(createGoogleCalendarClient()))
    registry.register(tool);
  registry.seal();
  return registry;
}
