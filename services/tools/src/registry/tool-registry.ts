import { ToolError } from "../errors/tool-error.js";
import { z } from "zod";
import type {
  AgentToolCapability,
  RegisteredTool,
  ToolDefinition,
  ToolMetadata,
} from "./tool-definition.js";

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();
  #sealed = false;

  public register<Input, Output>(tool: ToolDefinition<Input, Output>): void {
    if (this.#sealed) throw new Error("Tool registry is sealed");
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name}`);
    }
    if (!Number.isSafeInteger(tool.version) || tool.version < 1) {
      throw new Error(`Invalid tool version: ${tool.name}`);
    }
    if (!Number.isSafeInteger(tool.timeoutMs) || tool.timeoutMs < 1) {
      throw new Error(`Invalid tool timeout: ${tool.name}`);
    }
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.#tools.set(
      tool.name,
      Object.freeze({
        ...tool,
        requiredPermissions: Object.freeze([...tool.requiredPermissions]),
      }),
    );
  }

  public seal(): void {
    this.#sealed = true;
  }

  public get(name: string): RegisteredTool {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      throw new ToolError("TOOL_NOT_FOUND", 404, "Tool not found");
    }
    return tool;
  }

  public resolve(name: string, version: number): RegisteredTool {
    const tool = this.get(name);
    if (tool.version !== version) {
      throw new ToolError(
        "TOOL_VERSION_UNSUPPORTED",
        400,
        "Tool version is unsupported",
      );
    }
    if (!tool.enabled)
      throw new ToolError("TOOL_DISABLED", 409, "Tool is disabled");
    return tool;
  }

  public listMetadata(): readonly ToolMetadata[] {
    return [...this.#tools.values()]
      .map((tool) =>
        Object.freeze({
          name: tool.name,
          version: tool.version,
          title: tool.title,
          description: tool.description,
          category: tool.category,
          requiredPermissions: Object.freeze([...tool.requiredPermissions]),
          riskLevel: tool.riskLevel,
          approvalPolicy: tool.approvalPolicy,
          idempotency: tool.idempotency,
          timeoutMs: tool.timeoutMs,
          enabled: tool.enabled,
        }),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public listAgentCapabilities(): readonly AgentToolCapability[] {
    return Object.freeze(
      [...this.#tools.values()]
        .filter((tool) => tool.enabled)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((tool) =>
          Object.freeze({
            name: tool.name,
            description: tool.description,
            category: tool.category,
            inputSchema: z.toJSONSchema(tool.inputSchema),
          }),
        ),
    );
  }
}
