import { describe, expect, it } from "vitest";

import { ToolExecutor } from "../src/execution/tool-executor.js";
import { ToolRegistry } from "../src/registry/tool-registry.js";
import { calculatorTool } from "../src/tools/utility/calculator.tool.js";
import { createDatetimeTool } from "../src/tools/utility/datetime.tool.js";

const context = {
  requestId: "utility-test",
  actorId: "actor",
  grantedPermissions: ["utility.calculator", "utility.datetime"],
} as const;

function executor() {
  const registry = new ToolRegistry();
  registry.register(calculatorTool);
  registry.register(
    createDatetimeTool(() => new Date("2026-08-14T12:34:56.000Z")),
  );
  registry.seal();
  return new ToolExecutor(registry);
}

describe("utility.calculator", () => {
  it.each([
    ["2 + 3", 5],
    ["9 - 4", 5],
    ["6 * 7", 42],
    ["8 / 2", 4],
    ["(12.5 + 7.5) * 2", 40],
    ["-2.5 + 1", -1.5],
  ])("evaluates %s", async (expression, expected) => {
    await expect(
      executor().execute({
        tool: "utility.calculator",
        version: 1,
        input: { expression },
        context,
      }),
    ).resolves.toEqual({
      status: "success",
      tool: "utility.calculator",
      version: 1,
      data: { expression, result: expected },
    });
  });

  it.each([
    "process.exit()",
    "require('fs')",
    "1; console.log('x')",
    "constructor.constructor('x')()",
    "1 / 0",
    "(1 + 2",
    "1e309",
  ])("rejects unsafe or malformed expression %s", async (expression) => {
    await expect(
      executor().execute({
        tool: "utility.calculator",
        input: { expression },
        context,
      }),
    ).rejects.toMatchObject({ code: "CALCULATION_INVALID" });
  });

  it("rejects oversized input and missing permission", async () => {
    await expect(
      executor().execute({
        tool: "utility.calculator",
        input: { expression: "1".repeat(257) },
        context,
      }),
    ).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });
    await expect(
      executor().execute({
        tool: "utility.calculator",
        input: { expression: "1 + 1" },
        context: { ...context, grantedPermissions: [] },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("utility.datetime", () => {
  it.each([
    ["UTC", "2026-08-14", "12:34:56"],
    ["Asia/Kolkata", "2026-08-14", "18:04:56"],
  ])("returns structured time for %s", async (timezone, date, time) => {
    const result = await executor().execute({
      tool: "utility.datetime",
      input: { operation: "current_time", timezone },
      context,
    });
    expect(result).toEqual({
      status: "success",
      tool: "utility.datetime",
      version: 1,
      data: { timezone, iso: "2026-08-14T12:34:56.000Z", date, time },
    });
  });

  it.each([
    "Invalid/Zone",
    "../../etc/passwd",
    "SELECT * FROM users",
    "<script>alert(1)</script>",
  ])("rejects invalid timezone %s", async (timezone) => {
    await expect(
      executor().execute({
        tool: "utility.datetime",
        input: { operation: "current_time", timezone },
        context,
      }),
    ).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });
  });

  it("rejects missing permission", async () => {
    await expect(
      executor().execute({
        tool: "utility.datetime",
        input: { operation: "current_date", timezone: "UTC" },
        context: { ...context, grantedPermissions: [] },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
