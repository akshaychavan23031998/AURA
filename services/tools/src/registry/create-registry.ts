import { echoTool } from "../tools/system/echo.tool.js";
import { ToolRegistry } from "./tool-registry.js";

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  return registry;
}
