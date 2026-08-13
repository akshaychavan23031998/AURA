import { ToolError } from "../errors/tool-error.js";
import type {
  RegisteredTool,
  ToolDefinition,
  ToolMetadata,
} from "./tool-definition.js";

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  public register<Input, Output>(tool: ToolDefinition<Input, Output>): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  public get(name: string): RegisteredTool {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      throw new ToolError("TOOL_NOT_FOUND", 404, "Tool not found");
    }
    return tool;
  }

  public listMetadata(): readonly ToolMetadata[] {
    return [...this.#tools.values()]
      .map((tool) =>
        Object.freeze({
          name: tool.name,
          description: tool.description,
          requiredPermissions: Object.freeze([...tool.requiredPermissions]),
          riskLevel: tool.riskLevel,
          requiresApproval: tool.requiresApproval,
        }),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}
