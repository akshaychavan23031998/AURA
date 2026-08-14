import { z } from "zod";

import { ToolError } from "../../errors/tool-error.js";
import type { ToolDefinition } from "../../registry/tool-definition.js";

const MAX_EXPRESSION_LENGTH = 256;
const inputSchema = z
  .object({ expression: z.string().min(1).max(MAX_EXPRESSION_LENGTH) })
  .strict();
const outputSchema = z
  .object({ expression: z.string(), result: z.number().finite() })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

export const calculatorTool: ToolDefinition<Input, Output> = {
  name: "utility.calculator",
  version: 1,
  title: "Calculator",
  description:
    "Evaluates arithmetic containing decimal numbers, parentheses, addition, subtraction, multiplication, and division.",
  category: "utility",
  inputSchema,
  outputSchema,
  requiredPermissions: ["utility.calculator"],
  riskLevel: "READ",
  approvalPolicy: "NONE",
  idempotency: "IDEMPOTENT",
  timeoutMs: 1_000,
  enabled: true,
  execute: ({ expression }) => {
    try {
      const result = new ArithmeticParser(expression).parse();
      if (!Number.isFinite(result)) throw new Error("Non-finite result");
      return Promise.resolve({ expression, result });
    } catch (error) {
      throw new ToolError("CALCULATION_INVALID", 400, "Expression is invalid", {
        cause: error,
      });
    }
  },
};

class ArithmeticParser {
  #position = 0;

  public constructor(private readonly source: string) {}

  public parse(): number {
    const value = this.expression();
    this.whitespace();
    if (this.#position !== this.source.length)
      throw new Error("Unexpected token");
    return value;
  }

  private expression(): number {
    let value = this.term();
    while (true) {
      this.whitespace();
      if (this.take("+")) value += this.term();
      else if (this.take("-")) value -= this.term();
      else return value;
    }
  }

  private term(): number {
    let value = this.factor();
    while (true) {
      this.whitespace();
      if (this.take("*")) value *= this.factor();
      else if (this.take("/")) {
        const divisor = this.factor();
        if (divisor === 0) throw new Error("Division by zero");
        value /= divisor;
      } else return value;
    }
  }

  private factor(): number {
    this.whitespace();
    if (this.take("+")) return this.factor();
    if (this.take("-")) return -this.factor();
    if (this.take("(")) {
      const value = this.expression();
      this.whitespace();
      if (!this.take(")")) throw new Error("Unbalanced parentheses");
      return value;
    }
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(
      this.source.slice(this.#position),
    );
    if (match === null) throw new Error("Number expected");
    this.#position += match[0].length;
    return Number(match[0]);
  }

  private take(token: string): boolean {
    if (this.source[this.#position] !== token) return false;
    this.#position += 1;
    return true;
  }

  private whitespace(): void {
    while (/\s/.test(this.source[this.#position] ?? "")) this.#position += 1;
  }
}
