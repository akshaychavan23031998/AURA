import { sql } from "drizzle-orm";

import type { DatabaseClient } from "../db/client.js";
import type { MemoryKind } from "./memory-repository.js";

export interface SemanticMemoryRow {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly similarity: number;
}

export interface MemoryForBackfill {
  readonly id: string;
  readonly content: string;
}

const STORED_EMBEDDING_DIMENSIONS = 384;

export class MemoryEmbeddingRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async upsert(
    memoryId: string,
    model: string,
    embedding: readonly number[],
  ): Promise<void> {
    const vector = vectorLiteral(embedding);
    await this.database.db.execute(sql`
      insert into user_memory_embeddings (memory_id, model, embedding)
      values (${memoryId}, ${model}, ${vector}::vector)
      on conflict (memory_id, model)
      do update set embedding = excluded.embedding, created_at = now()
    `);
  }

  public async searchOwned(
    actorId: string,
    model: string,
    embedding: readonly number[],
    limit: number,
    minimumSimilarity: number,
  ): Promise<SemanticMemoryRow[]> {
    const vector = vectorLiteral(embedding);
    const result = await this.database.db.execute(sql`
      select m.id, m.kind, m.content,
        1 - (e.embedding <=> ${vector}::vector) as similarity
      from user_memories m
      inner join user_memory_embeddings e on e.memory_id = m.id
      where m.actor_id = ${actorId}
        and m.status = 'ACTIVE'
        and e.model = ${model}
        and 1 - (e.embedding <=> ${vector}::vector) >= ${minimumSimilarity}
      order by e.embedding <=> ${vector}::vector asc, m.id asc
      limit ${limit}
    `);
    return result.rows.map((row) => ({
      id: String(row["id"]),
      kind: row["kind"] as MemoryKind,
      content: String(row["content"]),
      similarity: Number(row["similarity"]),
    }));
  }

  public async listActiveMissing(model: string, limit: number) {
    const result = await this.database.db.execute(sql`
      select m.id, m.content
      from user_memories m
      where m.status = 'ACTIVE'
        and not exists (
          select 1 from user_memory_embeddings e
          where e.memory_id = m.id and e.model = ${model}
        )
      order by m.created_at asc, m.id asc
      limit ${limit}
    `);
    return result.rows.map((row) => ({
      id: String(row["id"]),
      content: String(row["content"]),
    }));
  }
}

function vectorLiteral(embedding: readonly number[]): string {
  if (
    embedding.length !== STORED_EMBEDDING_DIMENSIONS ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new TypeError("Invalid memory embedding vector");
  }
  return `[${embedding.join(",")}]`;
}
