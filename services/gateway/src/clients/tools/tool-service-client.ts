import { performance } from "node:perf_hooks";

import { z } from "zod";

import type { GatewayConfig } from "../../config/index.js";
import { AppError } from "../../errors/app-error.js";

export const TOOL_SERVICE_ID_HEADER = "x-aura-service-id";
export const TOOL_SERVICE_TOKEN_HEADER = "x-aura-service-token";

const successSchema = z
  .object({
    status: z.literal("success"),
    tool: z.string(),
    version: z.number().int().positive(),
    data: z.unknown(),
  })
  .strict();

const errorSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        requestId: z.string(),
      })
      .strict(),
  })
  .strict();

export interface PublicToolExecutionRequest {
  readonly tool: string;
  readonly input: unknown;
}

export interface TrustedToolContext {
  readonly actorId: string;
  readonly grantedPermissions: readonly string[];
}

export interface ToolExecutionResult {
  readonly status: "success";
  readonly tool: string;
  readonly version?: number;
  readonly data: unknown;
}

export interface ToolServiceClient {
  execute(
    request: PublicToolExecutionRequest,
    context: TrustedToolContext,
    requestId: string,
  ): Promise<ToolExecutionResult>;
}

export interface ToolClientLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
}

export function createToolServiceClient(
  config: GatewayConfig,
  fetchImplementation: typeof fetch = fetch,
  logger?: ToolClientLogger,
): ToolServiceClient {
  return {
    async execute(request, context, requestId) {
      const startedAt = performance.now();
      try {
        const response = await fetchImplementation(
          `${config.toolsService.url}/tools/execute`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-request-id": requestId,
              [TOOL_SERVICE_ID_HEADER]: "gateway",
              [TOOL_SERVICE_TOKEN_HEADER]: config.toolsService.token,
            },
            body: JSON.stringify({
              tool: request.tool,
              version: 1,
              input: request.input,
              context,
            }),
            signal: AbortSignal.timeout(config.toolsService.timeoutMs),
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
          const parsed = successSchema.safeParse(body);
          if (!parsed.success) throw protocolError();
          logger?.info(
            {
              upstream: "tools",
              operation: "execute",
              status: response.status,
              duration: performance.now() - startedAt,
              requestId,
            },
            "Tool Service call completed",
          );
          return parsed.data;
        }

        const parsedError = errorSchema.safeParse(body);
        if (!parsedError.success) throw protocolError();
        const allowedStatus = [400, 403, 404, 409, 500, 504].includes(
          response.status,
        );
        if (!allowedStatus) throw protocolError();
        throw new AppError({
          code: parsedError.data.error.code,
          httpStatus: response.status,
          message: clientSafeToolMessage(parsedError.data.error.code),
        });
      } catch (error) {
        logger?.warn(
          {
            upstream: "tools",
            operation: "execute",
            status: "failed",
            duration: performance.now() - startedAt,
            requestId,
          },
          "Tool Service call failed",
        );
        if (error instanceof AppError) throw error;
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new AppError({
            code: "UPSTREAM_SERVICE_TIMEOUT",
            httpStatus: 504,
            message: "Tool Service timed out",
            cause: error,
          });
        }
        throw new AppError({
          code: "UPSTREAM_SERVICE_UNAVAILABLE",
          httpStatus: 502,
          message: "Tool Service unavailable",
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
    message: "Tool Service returned an invalid response",
  });
}

function clientSafeToolMessage(code: string): string {
  const messages: Record<string, string> = {
    TOOL_NOT_FOUND: "Tool not found",
    TOOL_DISABLED: "Tool is unavailable",
    TOOL_VERSION_UNSUPPORTED: "Tool version is unsupported",
    TOOL_INPUT_INVALID: "Tool input is invalid",
    TOOL_OUTPUT_INVALID: "Tool execution failed",
    PERMISSION_DENIED: "Tool permission denied",
    TOOL_APPROVAL_REQUIRED: "Tool approval is required",
    TOOL_EXECUTION_FAILED: "Tool execution failed",
    TOOL_TIMEOUT: "Tool execution timed out",
  };
  return messages[code] ?? "Tool request failed";
}
