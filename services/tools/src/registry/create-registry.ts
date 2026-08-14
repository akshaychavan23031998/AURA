import { echoTool } from "../tools/system/echo.tool.js";
import { calculatorTool } from "../tools/utility/calculator.tool.js";
import { datetimeTool } from "../tools/utility/datetime.tool.js";
import { ToolRegistry } from "./tool-registry.js";

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  registry.register(calculatorTool);
  registry.register(datetimeTool);
  registry.seal();
  return registry;
}
