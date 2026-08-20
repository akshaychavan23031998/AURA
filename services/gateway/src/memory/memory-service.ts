import { AppError } from "../errors/app-error.js";
import {
  type CreateMemoryValue,
  type ListMemoryOptions,
  MemoryRepository,
} from "./memory-repository.js";

export interface MemoryView {
  readonly id: string;
  readonly kind: CreateMemoryValue["kind"];
  readonly content: string;
  readonly source: "user_explicit";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryStore {
  readonly create: (
    actorId: string,
    value: CreateMemoryValue,
  ) => Promise<MemoryView>;
  readonly getOwned: (actorId: string, memoryId: string) => Promise<MemoryView>;
  readonly listOwned: (
    actorId: string,
    options: ListMemoryOptions,
  ) => Promise<MemoryView[]>;
  readonly deleteOwned: (actorId: string, memoryId: string) => Promise<void>;
}

export class MemoryService implements MemoryStore {
  public constructor(private readonly repository: MemoryRepository) {}

  public async create(actorId: string, value: CreateMemoryValue) {
    try {
      return view(await this.repository.create(actorId, value));
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
