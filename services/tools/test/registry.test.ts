import { z } from "zod";
import { describe, expect, it } from "vitest";

import { ToolError } from "../src/errors/tool-error.js";
import { ToolRegistry } from "../src/registry/tool-registry.js";
import type { ToolDefinition } from "../src/registry/tool-definition.js";
import { createToolRegistry } from "../src/registry/create-registry.js";

const testTool: ToolDefinition<{ value: string }, { value: string }> = {
  name: "test.read",
  version: 1,
  title: "Test read",
  description: "Reads a test value.",
  category: "system",
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ value: z.string() }),
  requiredPermissions: ["system.echo"],
  riskLevel: "READ",
  approvalPolicy: "NONE",
  idempotency: "IDEMPOTENT",
  timeoutMs: 100,
  enabled: true,
  execute: (input) => Promise.resolve(input),
};

describe("ToolRegistry", () => {
  it("registers exactly the production tools in deterministic order", () => {
    expect(
      createToolRegistry()
        .listMetadata()
        .map((tool) => tool.name),
    ).toEqual([
      "calendar.events.create",
      "calendar.events.delete",
      "calendar.events.get",
      "calendar.events.list",
      "calendar.events.update",
      "contacts.people.get",
      "contacts.people.list",
      "gmail.messages.get",
      "gmail.messages.list",
      "gmail.messages.reply",
      "gmail.messages.send",
      "system.echo",
      "utility.calculator",
      "utility.datetime",
    ]);
  });
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
        version: 1,
        title: "Test read",
        description: "Reads a test value.",
        category: "system",
        requiredPermissions: ["system.echo"],
        riskLevel: "READ",
        approvalPolicy: "NONE",
        idempotency: "IDEMPOTENT",
        timeoutMs: 100,
        enabled: true,
      },
    ]);
    expect(Object.isFrozen(metadata[0]?.requiredPermissions)).toBe(true);
  });

  it("rejects malformed identifiers and registration after sealing", () => {
    const registry = new ToolRegistry();
    expect(() => registry.register({ ...testTool, name: "invalid" })).toThrow(
      /Invalid tool name/,
    );
    registry.register(testTool);
    registry.seal();
    expect(() =>
      registry.register({ ...testTool, name: "test.other" }),
    ).toThrow(/sealed/);
  });

  it("exposes only sanitized Agent capabilities", () => {
    const registry = new ToolRegistry();
    registry.register(testTool);
    const capability = registry.listAgentCapabilities()[0];
    expect(capability?.name).toBe("test.read");
    expect(capability?.category).toBe("system");
    expect(typeof capability?.inputSchema).toBe("object");
    expect(capability).not.toHaveProperty("requiredPermissions");
    expect(capability).not.toHaveProperty("execute");
    expect(capability).not.toHaveProperty("riskLevel");
  });
});
