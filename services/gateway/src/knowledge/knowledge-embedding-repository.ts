import { sql } from "drizzle-orm";

import type { DatabaseClient } from "../db/client.js";

export interface KnowledgeChunkForEmbedding {
  readonly id: string;
  readonly documentId: string;
  readonly content: string;
}

export interface SemanticKnowledgeRow {
  readonly documentId: string;
  readonly chunkId: string;
  readonly title: string;
  readonly content: string;
  readonly ordinal: number;
  readonly similarity: number;
}

const STORED_EMBEDDING_DIMENSIONS = 384;

export class KnowledgeEmbeddingRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async upsert(
    chunkId: string,
    model: string,
    embedding: readonly number[],
  ): Promise<void> {
    const vector = vectorLiteral(embedding);
    await this.database.db.execute(sql`
      insert into knowledge_chunk_embeddings (chunk_id, model, embedding)
      values (${chunkId}, ${model}, ${vector}::vector)
      on conflict (chunk_id, model)
      do update set embedding = excluded.embedding, created_at = now()
    `);
  }

  public async listActiveMissing(
    model: string,
    limit: number,
  ): Promise<KnowledgeChunkForEmbedding[]> {
    const result = await this.database.db.execute(sql`
      select c.id, c.document_id, c.content
      from knowledge_chunks c
      inner join knowledge_documents d on d.id = c.document_id
      where d.status = 'ACTIVE'
        and not exists (
          select 1 from knowledge_chunk_embeddings e
          where e.chunk_id = c.id and e.model = ${model}
        )
      order by d.created_at asc, d.id asc, c.ordinal asc, c.id asc
      limit ${limit}
    `);
    return result.rows.map((row) => ({
      id: String(row["id"]),
      documentId: String(row["document_id"]),
      content: String(row["content"]),
    }));
  }

  public async searchOwned(
    actorId: string,
    model: string,
    embedding: readonly number[],
    limit: number,
    minimumSimilarity: number,
  ): Promise<SemanticKnowledgeRow[]> {
    const vector = vectorLiteral(embedding);
    const result = await this.database.db.execute(sql`
      select d.id as document_id, c.id as chunk_id, d.title, c.content,
        c.ordinal, 1 - (e.embedding <=> ${vector}::vector) as similarity
      from knowledge_chunk_embeddings e
      inner join knowledge_chunks c on c.id = e.chunk_id
      inner join knowledge_documents d on d.id = c.document_id
      where d.actor_id = ${actorId}
        and d.status = 'ACTIVE'
        and e.model = ${model}
        and 1 - (e.embedding <=> ${vector}::vector) >= ${minimumSimilarity}
      order by e.embedding <=> ${vector}::vector asc,
        d.id asc, c.ordinal asc, c.id asc
      limit ${limit}
    `);
    return result.rows.map((row) => ({
      documentId: String(row["document_id"]),
      chunkId: String(row["chunk_id"]),
      title: String(row["title"]),
      content: String(row["content"]),
      ordinal: Number(row["ordinal"]),
      similarity: Number(row["similarity"]),
    }));
  }
}

function vectorLiteral(embedding: readonly number[]): string {
  if (
    embedding.length !== STORED_EMBEDDING_DIMENSIONS ||
    embedding.some((value) => !Number.isFinite(value))
  )
    throw new TypeError("Invalid knowledge embedding vector");
  return `[${embedding.join(",")}]`;
}
