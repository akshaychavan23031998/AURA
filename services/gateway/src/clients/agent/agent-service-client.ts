import { performance } from "node:perf_hooks";

import { z } from "zod";

import type { GatewayConfig } from "../../config/index.js";
import { AppError } from "../../errors/app-error.js";
import { withTimeout } from "../abort-signal.js";
import { isAbortError } from "../../voice/cancellation.js";

export const INTERNAL_SERVICE_ID_HEADER = "x-aura-service-id";
export const INTERNAL_SERVICE_TOKEN_HEADER = "x-aura-service-token";

const toolProposalSchema = z
  .object({
    name: z.string().min(1).max(128),
    input: z.record(z.string(), z.json()),
  })
  .strict();

const agentResponseSchema = z
  .object({
    requestId: z.string(),
    intent: z.string(),
    response: z.string(),
    plan: z.discriminatedUnion("type", [
      z.object({ type: z.literal("respond") }).strict(),
      z.object({ type: z.literal("tool"), tool: toolProposalSchema }).strict(),
      z
        .object({
          type: z.literal("memory_read"),
          kind: z
            .enum(["preference", "fact", "instruction", "note"])
            .nullable(),
        })
        .strict(),
      z
        .object({
          type: z.literal("memory_search"),
          query: z.string().trim().min(1).max(1024),
        })
        .strict(),
      z
        .object({
          type: z.literal("memory_create"),
          kind: z.enum(["preference", "fact", "instruction", "note"]),
          content: z.string().trim().min(1).max(4096),
        })
        .strict(),
      z
        .object({
          type: z.literal("memory_delete"),
          memoryId: z.uuid(),
        })
        .strict(),
      z
        .object({
          type: z.literal("knowledge_search"),
          query: z
            .string()
            .trim()
            .min(1)
            .max(1024)
            .refine((value) => !hasUnsafeControl(value)),
        })
        .strict(),
    ]),
    citationIds: z
      .array(
        z
          .string()
          .regex(/^K[1-9][0-9]?$/)
          .max(3),
      )
      .max(10)
      .nullable()
      .optional(),
  })
  .strict();

const errorSchema = z
  .object({
    error: z
      .object({ code: z.string(), message: z.string(), requestId: z.string() })
      .strict(),
  })
  .strict();

export interface AgentRequest {
  readonly message: string;
  readonly conversationId?: string;
  readonly locale?: string;
  readonly toolResult?: ToolExecutionResultContext;
  readonly memoryContext?: readonly MemoryContextItem[];
  readonly memoryResult?: MemoryMutationResultContext;
  readonly knowledgeContext?: readonly KnowledgeContextItem[];
}

export interface KnowledgeContextItem {
  readonly reference: string;
  readonly title: string;
  readonly content: string;
  readonly ordinal: number;
}

export interface MemoryContextItem {
  readonly id: string;
  readonly kind: "preference" | "fact" | "instruction" | "note";
  readonly content: string;
}

export type MemoryMutationResultContext =
  | { readonly operation: "created"; readonly memory: MemoryContextItem }
  | { readonly operation: "deleted"; readonly memoryId: string };

export interface ToolExecutionResultContext {
  readonly tool: string;
  readonly status: "success";
  readonly data: unknown;
}

export type AgentResult = z.infer<typeof agentResponseSchema>;

export interface AgentServiceClient {
  respond(
    request: AgentRequest,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<AgentResult>;
}

export interface AgentClientLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
}

export function createAgentServiceClient(
  config: GatewayConfig,
  fetchImplementation: typeof fetch = fetch,
  logger?: AgentClientLogger,
): AgentServiceClient {
  return {
    async respond(request, requestId, signal) {
      const startedAt = performance.now();
      try {
        const response = await fetchImplementation(
          `${config.agentService.url}/v1/agent/respond`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-request-id": requestId,
              [INTERNAL_SERVICE_ID_HEADER]: "gateway",
              [INTERNAL_SERVICE_TOKEN_HEADER]: config.agentService.token,
            },
            body: JSON.stringify(request),
            signal: withTimeout(signal, config.agentService.timeoutMs),
          },
        );
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
          throw protocolError();
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw protocolError();
        }
        if (response.ok) {
          const parsed = agentResponseSchema.safeParse(body);
          if (!parsed.success || parsed.data.requestId !== requestId) {
            throw protocolError();
          }
          logger?.info(
            {
              upstream: "agent",
              operation: "respond",
              status: response.status,
              duration: performance.now() - startedAt,
              requestId,
            },
            "Agent Service call completed",
          );
          return parsed.data;
        }
        const parsedError = errorSchema.safeParse(body);
        if (!parsedError.success) throw protocolError();
        if (![400, 401, 413, 500].includes(response.status)) {
          throw protocolError();
        }
        throw new AppError({
          code: parsedError.data.error.code,
          httpStatus: response.status === 401 ? 502 : response.status,
          message: safeAgentMessage(parsedError.data.error.code),
        });
      } catch (error) {
        logger?.warn(
          {
            upstream: "agent",
            operation: "respond",
            status: "failed",
            duration: performance.now() - startedAt,
            requestId,
          },
          "Agent Service call failed",
        );
        if (error instanceof AppError || isAbortError(error)) throw error;
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new AppError({
            code: "UPSTREAM_SERVICE_TIMEOUT",
            httpStatus: 504,
            message: "Agent Service timed out",
            cause: error,
          });
        }
        throw new AppError({
          code: "UPSTREAM_SERVICE_UNAVAILABLE",
          httpStatus: 502,
          message: "Agent Service unavailable",
          cause: error,
        });
      }
    },
  };
}

function protocolError(): AppError {
  return new AppError({
    code: "UPSTREAM_PROTOCOL_ERROR",
    httpStatus: 502,
    message: "Agent Service returned an invalid response",
  });
}

function safeAgentMessage(code: string): string {
  const messages: Record<string, string> = {
    VALIDATION_ERROR: "Request validation failed",
    PAYLOAD_TOO_LARGE: "Request payload is too large",
    AGENT_PLANNING_FAILED: "Agent planning failed",
    INTERNAL_SERVER_ERROR: "Agent Service request failed",
  };
  return messages[code] ?? "Agent Service request failed";
}

function hasUnsafeControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      (code >= 127 && code <= 159)
    );
  });
}
