import { AppError } from "../errors/app-error.js";
import {
  type CreateMemoryValue,
  type ListMemoryOptions,
  MemoryRepository,
} from "./memory-repository.js";
import type { MemoryEmbeddingClient } from "./memory-embedding-client.js";
import type { MemoryEmbeddingRepository } from "./memory-embedding-repository.js";

export interface MemoryView {
  readonly id: string;
  readonly kind: CreateMemoryValue["kind"];
  readonly content: string;
  readonly source: "user_explicit";
  readonly createdAt: string;
  readonly updatedAt: string;
}
export type MemoryContextView = Pick<MemoryView, "id" | "kind" | "content">;

export interface MemoryStore {
  readonly create: (
    actorId: string,
    value: CreateMemoryValue,
    requestId?: string,
  ) => Promise<MemoryView>;
  readonly getOwned: (actorId: string, memoryId: string) => Promise<MemoryView>;
  readonly listOwned: (
    actorId: string,
    options: ListMemoryOptions,
  ) => Promise<MemoryView[]>;
  readonly deleteOwned: (actorId: string, memoryId: string) => Promise<void>;
  readonly searchOwnedRelevant?: (
    actorId: string,
    query: string,
    requestId: string,
  ) => Promise<MemoryContextView[]>;
}

export class MemoryService implements MemoryStore {
  public constructor(
    private readonly repository: MemoryRepository,
    private readonly embeddings?: {
      readonly client: MemoryEmbeddingClient;
      readonly repository: MemoryEmbeddingRepository;
      readonly searchLimit: number;
      readonly minimumSimilarity: number;
      readonly log?: {
        warn(fields: Record<string, unknown>, message: string): void;
        info(fields: Record<string, unknown>, message: string): void;
      };
    },
  ) {}

  public async create(
    actorId: string,
    value: CreateMemoryValue,
    requestId = "memory-create",
  ) {
    const normalized = normalizeCreate(value);
    try {
      const row = await this.repository.create(actorId, normalized);
      if (this.embeddings !== undefined)
        await this.embedBestEffort(row.id, row.content, requestId);
      return view(row);
    } catch {
      throw storageFailed();
    }
  }

  public async getOwned(actorId: string, memoryId: string) {
    let row;
    try {
      row = await this.repository.getOwned(actorId, memoryId);
    } catch {
      throw storageFailed();
    }
    if (row === undefined) throw notFound();
    return view(row);
  }

  public async listOwned(actorId: string, options: ListMemoryOptions) {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 50 ||
      (options.kind !== undefined && !memoryKinds.has(options.kind))
    )
      throw inputInvalid();
    try {
      return (await this.repository.listOwned(actorId, options)).map(view);
    } catch {
      throw storageFailed();
    }
  }

  public async deleteOwned(actorId: string, memoryId: string) {
    let deleted;
    try {
      deleted = await this.repository.deleteOwned(
        actorId,
        memoryId,
        new Date(),
      );
    } catch {
      throw storageFailed();
    }
    if (deleted === undefined) throw notFound();
  }

  public async searchOwnedRelevant(
    actorId: string,
    query: string,
    requestId: string,
  ): Promise<MemoryContextView[]> {
    if (this.embeddings === undefined) throw embeddingUnavailable();
    const normalized = normalizeQuery(query);
    try {
      const vector = await this.embeddings.client.embed(normalized, requestId);
      const rows = await this.embeddings.repository.searchOwned(
        actorId,
        this.embeddings.client.model,
        vector,
        this.embeddings.searchLimit,
        this.embeddings.minimumSimilarity,
      );
      this.embeddings.log?.info(
        { requestId, operation: "memory_search", resultCount: rows.length },
        "Semantic memory search completed",
      );
      return rows.map((row) =>
        Object.freeze({
          id: row.id,
          kind: row.kind,
          content: row.content,
        }),
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw searchFailed();
    }
  }

  public async backfill(batchSize: number, requestId = "memory-backfill") {
    if (this.embeddings === undefined) throw embeddingUnavailable();
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
      throw inputInvalid();
    const rows = await this.embeddings.repository.listActiveMissing(
      this.embeddings.client.model,
      batchSize,
    );
    let embedded = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const vector = await this.embeddings.client.embed(
          row.content,
          requestId,
        );
        await this.embeddings.repository.upsert(
          row.id,
          this.embeddings.client.model,
          vector,
        );
        embedded += 1;
      } catch {
        failed += 1;
      }
    }
    return Object.freeze({ scanned: rows.length, embedded, failed });
  }

  private async embedBestEffort(
    memoryId: string,
    content: string,
    requestId: string,
  ): Promise<void> {
    try {
      const vector = await this.embeddings!.client.embed(content, requestId);
      await this.embeddings!.repository.upsert(
        memoryId,
        this.embeddings!.client.model,
        vector,
      );
    } catch {
      this.embeddings!.log?.warn(
        { requestId, operation: "memory_embedding", outcome: "failed" },
        "Memory persisted without an embedding",
      );
    }
  }
}

const memoryKinds = new Set<CreateMemoryValue["kind"]>([
  "preference",
  "fact",
  "instruction",
  "note",
]);

function normalizeCreate(value: CreateMemoryValue): CreateMemoryValue {
  const content = value.content.trim();
  if (
    !memoryKinds.has(value.kind) ||
    content.length < 1 ||
    content.length > 4096 ||
    hasForbiddenControlCharacter(content)
  )
    throw inputInvalid();
  return { kind: value.kind, content };
}

function hasForbiddenControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
    );
  });
}

function inputInvalid(): AppError {
  return new AppError({
    code: "MEMORY_INPUT_INVALID",
    httpStatus: 400,
    message: "Memory input is invalid",
  });
}

function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 1024 ||
    hasForbiddenControlCharacter(normalized)
  )
    throw inputInvalid();
  return normalized;
}

function embeddingUnavailable(): AppError {
  return new AppError({
    code: "MEMORY_EMBEDDING_UNAVAILABLE",
    httpStatus: 503,
    message: "Semantic memory retrieval is unavailable",
  });
}

function searchFailed(): AppError {
  return new AppError({
    code: "MEMORY_SEARCH_FAILED",
    httpStatus: 500,
    message: "Semantic memory search failed",
  });
}

function view(row: {
  id: string;
  kind: CreateMemoryValue["kind"];
  content: string;
  source: "user_explicit";
  createdAt: Date;
  updatedAt: Date;
}): MemoryView {
  return Object.freeze({
    id: row.id,
    kind: row.kind,
    content: row.content,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function notFound(): AppError {
  return new AppError({
    code: "MEMORY_NOT_FOUND",
    httpStatus: 404,
    message: "Memory not found",
  });
}

function storageFailed(): AppError {
  return new AppError({
    code: "MEMORY_STORAGE_FAILED",
    httpStatus: 500,
    message: "Memory storage operation failed",
  });
}
