import { z } from "zod";
import { describe, expect, it } from "vitest";

import { ToolError } from "../src/errors/tool-error.js";
import { ToolRegistry } from "../src/registry/tool-registry.js";
import type { ToolDefinition } from "../src/registry/tool-definition.js";

const testTool: ToolDefinition<{ value: string }, { value: string }> = {
  name: "test.read",
  description: "Reads a test value.",
  inputSchema: z.object({ value: z.string() }),
  requiredPermissions: ["test.read"],
  riskLevel: "READ",
  requiresApproval: false,
  execute: (input) => Promise.resolve(input),
};

describe("ToolRegistry", () => {
  it("registers and retrieves an explicit tool", () => {
    const registry = new ToolRegistry();
    registry.register(testTool);
    expect(registry.get("test.read").name).toBe("test.read");
  });

  it("rejects duplicate registration", () => {
    const registry = new ToolRegistry();
    registry.register(testTool);
    expect(() => registry.register(testTool)).toThrow(/already registered/);
  });

  it("rejects unknown tools safely", () => {
    expect(() => new ToolRegistry().get("does.not.exist")).toThrowError(
      ToolError,
    );
    try {
      new ToolRegistry().get("does.not.exist");
    } catch (error) {
      expect(error).toMatchObject({ code: "TOOL_NOT_FOUND" });
    }
  });

  it("returns sorted immutable safe metadata", () => {
    const registry = new ToolRegistry();
    registry.register(testTool);
    const metadata = registry.listMetadata();
    expect(metadata).toEqual([
      {
        name: "test.read",
        description: "Reads a test value.",
        requiredPermissions: ["test.read"],
        riskLevel: "READ",
        requiresApproval: false,
      },
    ]);
    expect(Object.isFrozen(metadata[0]?.requiredPermissions)).toBe(true);
  });
});
