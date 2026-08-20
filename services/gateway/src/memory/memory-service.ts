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
    const normalized = normalizeCreate(value);
    try {
      return view(await this.repository.create(actorId, normalized));
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
