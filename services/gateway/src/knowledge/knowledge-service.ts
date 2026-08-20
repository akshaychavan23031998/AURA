import { createHash } from "node:crypto";

import { AppError } from "../errors/app-error.js";
import type { EmbeddingClient } from "../memory/memory-embedding-client.js";
import type {
  KnowledgeChunkForEmbedding,
  KnowledgeEmbeddingRepository,
} from "./knowledge-embedding-repository.js";
import {
  KnowledgeRepository,
  type PreparedKnowledgeDocument,
} from "./knowledge-repository.js";
import { chunkKnowledgeText } from "./text-chunker.js";
import {
  hasForbiddenControlCharacter,
  normalizeKnowledgeText,
} from "./text-normalizer.js";

export interface CreateKnowledgeInput {
  readonly title: string;
  readonly content: string;
}

export interface KnowledgeDocumentMetadataView {
  readonly id: string;
  readonly title: string;
  readonly sourceType: "manual_text";
  readonly chunkCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KnowledgeDocumentView extends KnowledgeDocumentMetadataView {
  readonly content: string;
}

export interface KnowledgeStore {
  readonly create: (
    actorId: string,
    input: CreateKnowledgeInput,
    requestId?: string,
  ) => Promise<KnowledgeDocumentMetadataView>;
  readonly listOwned: (
    actorId: string,
    limit: number,
  ) => Promise<KnowledgeDocumentMetadataView[]>;
  readonly getOwned: (
    actorId: string,
    documentId: string,
  ) => Promise<KnowledgeDocumentView>;
  readonly deleteOwned: (
    actorId: string,
    documentId: string,
    requestId?: string,
  ) => Promise<void>;
}

export interface KnowledgeEmbeddingRuntime {
  readonly client: EmbeddingClient;
  readonly repository: KnowledgeEmbeddingRepository;
  readonly concurrency?: number;
}

export interface KnowledgeBackfillResult {
  readonly processed: number;
  readonly embedded: number;
  readonly failed: number;
}

const DEFAULT_EMBEDDING_CONCURRENCY = 2;

export class KnowledgeService implements KnowledgeStore {
  public constructor(
    private readonly repository: KnowledgeRepository,
    private readonly log?: {
      info(fields: Record<string, unknown>, message: string): void;
    },
    private readonly embeddings?: KnowledgeEmbeddingRuntime,
  ) {}

  public async create(
    actorId: string,
    input: CreateKnowledgeInput,
    requestId = "knowledge-create",
  ) {
    const prepared = prepare(input);
    let row;
    try {
      row = await this.repository.createTransactional(actorId, prepared);
      this.log?.info(
        {
          requestId,
          operation: "knowledge_ingestion",
          documentId: row.id,
          contentLength: Buffer.byteLength(prepared.normalizedContent, "utf8"),
          chunkCount: row.chunkCount,
          outcome: "created",
        },
        "Knowledge document ingested",
      );
    } catch {
      throw ingestionFailed();
    }
    const chunks = "chunks" in row ? row.chunks : [];
    await this.indexBestEffort(chunks, requestId, row.id);
    return metadataView(row);
  }

  public async listOwned(actorId: string, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw inputInvalid();
    try {
      return (await this.repository.listOwned(actorId, limit)).map(
        metadataView,
      );
    } catch {
      throw storageFailed();
    }
  }

  public async getOwned(actorId: string, documentId: string) {
    let row;
    try {
      row = await this.repository.getOwned(actorId, documentId);
    } catch {
      throw storageFailed();
    }
    if (row === undefined) throw notFound();
    return Object.freeze({
      ...metadataView(row),
      content: row.normalizedContent,
    });
  }

  public async deleteOwned(
    actorId: string,
    documentId: string,
    requestId = "knowledge-delete",
  ) {
    let row;
    try {
      row = await this.repository.deleteOwned(actorId, documentId, new Date());
    } catch {
      throw storageFailed();
    }
    if (row === undefined) throw notFound();
    this.log?.info(
      {
        requestId,
        operation: "knowledge_delete",
        documentId,
        outcome: "deleted",
      },
      "Knowledge document deleted",
    );
  }

  public async backfill(
    batchSize: number,
    requestId = "knowledge-embedding-backfill",
  ): Promise<KnowledgeBackfillResult> {
    if (this.embeddings === undefined) throw embeddingUnavailable();
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
      throw inputInvalid();
    let chunks: KnowledgeChunkForEmbedding[];
    try {
      chunks = await this.embeddings.repository.listActiveMissing(
        this.embeddings.client.model,
        batchSize,
      );
    } catch {
      throw embeddingUnavailable();
    }
    const result = await this.embedChunks(chunks, requestId);
    this.logIndexing(requestId, undefined, result, "backfill");
    return Object.freeze({ processed: chunks.length, ...result });
  }

  private async indexBestEffort(
    chunks: readonly KnowledgeChunkForEmbedding[],
    requestId: string,
    documentId: string,
  ): Promise<void> {
    if (this.embeddings === undefined || chunks.length === 0) return;
    const result = await this.embedChunks(chunks, requestId);
    this.logIndexing(requestId, documentId, result, "post_ingestion");
  }

  private async embedChunks(
    chunks: readonly KnowledgeChunkForEmbedding[],
    requestId: string,
  ): Promise<{ embedded: number; failed: number }> {
    const runtime = this.embeddings;
    if (runtime === undefined) return { embedded: 0, failed: chunks.length };
    const concurrency = Math.min(
      Math.max(runtime.concurrency ?? DEFAULT_EMBEDDING_CONCURRENCY, 1),
      4,
    );
    let cursor = 0;
    let embedded = 0;
    let failed = 0;
    const worker = async () => {
      while (cursor < chunks.length) {
        const chunk = chunks[cursor++];
        if (chunk === undefined) continue;
        try {
          const vector = await runtime.client.embed(chunk.content, requestId);
          await runtime.repository.upsert(
            chunk.id,
            runtime.client.model,
            vector,
          );
          embedded += 1;
        } catch {
          failed += 1;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, chunks.length) }, worker),
    );
    return { embedded, failed };
  }

  private logIndexing(
    requestId: string,
    documentId: string | undefined,
    result: { embedded: number; failed: number },
    mode: "post_ingestion" | "backfill",
  ): void {
    this.log?.info(
      {
        requestId,
        operation: "knowledge_embedding",
        ...(documentId === undefined ? {} : { documentId }),
        mode,
        embeddedCount: result.embedded,
        failedCount: result.failed,
        outcome: result.failed === 0 ? "indexed" : "partial",
      },
      "Knowledge chunk indexing completed",
    );
  }
}

function prepare(input: CreateKnowledgeInput): PreparedKnowledgeDocument {
  const title = input.title.trim();
  if (
    title.length < 1 ||
    title.length > 200 ||
    hasForbiddenControlCharacter(title) ||
    title.includes("\n") ||
    title.includes("\t")
  )
    throw inputInvalid();
  let normalizedContent: string;
  let chunks: readonly string[];
  try {
    normalizedContent = normalizeKnowledgeText(input.content);
    chunks = chunkKnowledgeText(normalizedContent);
  } catch {
    throw inputInvalid();
  }
  return Object.freeze({
    title,
    normalizedContent,
    contentHash: sha256(normalizedContent),
    chunks: chunks.map((content, ordinal) =>
      Object.freeze({ ordinal, content, contentHash: sha256(content) }),
    ),
  });
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function metadataView(row: {
  id: string;
  title: string;
  sourceType: "manual_text";
  chunkCount: number;
  createdAt: Date;
  updatedAt: Date;
}): KnowledgeDocumentMetadataView {
  return Object.freeze({
    id: row.id,
    title: row.title,
    sourceType: row.sourceType,
    chunkCount: Number(row.chunkCount),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function inputInvalid(): AppError {
  return new AppError({
    code: "KNOWLEDGE_INPUT_INVALID",
    httpStatus: 400,
    message: "Knowledge input is invalid",
  });
}

function notFound(): AppError {
  return new AppError({
    code: "KNOWLEDGE_NOT_FOUND",
    httpStatus: 404,
    message: "Knowledge document not found",
  });
}

function storageFailed(): AppError {
  return new AppError({
    code: "KNOWLEDGE_STORAGE_FAILED",
    httpStatus: 500,
    message: "Knowledge storage operation failed",
  });
}

function ingestionFailed(): AppError {
  return new AppError({
    code: "KNOWLEDGE_INGESTION_FAILED",
    httpStatus: 500,
    message: "Knowledge ingestion failed",
  });
}

function embeddingUnavailable(): AppError {
  return new AppError({
    code: "KNOWLEDGE_EMBEDDING_UNAVAILABLE",
    httpStatus: 503,
    message: "Knowledge embedding service is unavailable",
  });
}
