import { AppError } from "../errors/app-error.js";
import { z } from "zod";

export interface EmbeddingClient {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string, requestId: string): Promise<readonly number[]>;
}

// Compatibility name retained for the Phase 31 memory API. The runtime is
// intentionally content-agnostic and is also used for knowledge chunks.
export type MemoryEmbeddingClient = EmbeddingClient;

export interface MemoryEmbeddingClientConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly dimensions: number;
  readonly timeoutMs: number;
}

export function createMemoryEmbeddingClient(
  config: MemoryEmbeddingClientConfig,
  fetchImplementation: typeof fetch = fetch,
): MemoryEmbeddingClient {
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/v1/embeddings`;
  return Object.freeze({
    model: config.model,
    dimensions: config.dimensions,
    async embed(text: string, requestId: string) {
      let response: Response;
      try {
        response = await fetchImplementation(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
          },
          body: JSON.stringify({ model: config.model, input: text }),
          redirect: "error",
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch {
        throw unavailable();
      }
      if (!response.ok) throw unavailable();
      const body = await readBounded(response, 256 * 1024);
      const parsed = embeddingResponse(body);
      validateEmbedding(parsed, config.dimensions);
      return Object.freeze(parsed);
    },
  });
}

async function readBounded(
  response: Response,
  maximum: number,
): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maximum) throw unavailable();
  const text = await response.text();
  if (text.length > maximum) throw unavailable();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw unavailable();
  }
}

function embeddingResponse(value: unknown): number[] {
  const parsed = z
    .object({
      data: z
        .array(z.object({ embedding: z.array(z.number()) }).strict())
        .length(1),
    })
    .strict()
    .safeParse(value);
  if (!parsed.success) throw unavailable();
  return parsed.data.data[0]!.embedding;
}

export function validateEmbedding(
  value: readonly number[],
  dimensions: number,
): void {
  if (
    value.length !== dimensions ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  )
    throw unavailable();
}

function unavailable(): AppError {
  return new AppError({
    code: "MEMORY_EMBEDDING_UNAVAILABLE",
    httpStatus: 503,
    message: "Memory embedding service is unavailable",
  });
}
