import { and, desc, eq, sql } from "drizzle-orm";

import type { DatabaseClient } from "../db/client.js";
import { knowledgeChunks, knowledgeDocuments } from "../db/schema.js";

export interface PreparedKnowledgeChunk {
  readonly ordinal: number;
  readonly content: string;
  readonly contentHash: string;
}

export interface PreparedKnowledgeDocument {
  readonly title: string;
  readonly normalizedContent: string;
  readonly contentHash: string;
  readonly chunks: readonly PreparedKnowledgeChunk[];
}

const chunkCount = sql<number>`count(${knowledgeChunks.id})::integer`.mapWith(
  Number,
);

export class KnowledgeRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async createTransactional(
    actorId: string,
    value: PreparedKnowledgeDocument,
  ) {
    return this.database.db.transaction(async (transaction) => {
      const [document] = await transaction
        .insert(knowledgeDocuments)
        .values({
          actorId,
          title: value.title,
          normalizedContent: value.normalizedContent,
          contentHash: value.contentHash,
        })
        .returning();
      if (document === undefined)
        throw new Error("Knowledge persistence failed");
      const chunks = await transaction
        .insert(knowledgeChunks)
        .values(
          value.chunks.map((chunk) => ({
            documentId: document.id,
            ordinal: chunk.ordinal,
            content: chunk.content,
            contentHash: chunk.contentHash,
          })),
        )
        .returning({
          id: knowledgeChunks.id,
          documentId: knowledgeChunks.documentId,
          ordinal: knowledgeChunks.ordinal,
          content: knowledgeChunks.content,
        });
      return { ...document, chunkCount: value.chunks.length, chunks };
    });
  }

  public async getOwned(actorId: string, documentId: string) {
    const [row] = await this.database.db
      .select({
        id: knowledgeDocuments.id,
        actorId: knowledgeDocuments.actorId,
        title: knowledgeDocuments.title,
        sourceType: knowledgeDocuments.sourceType,
        status: knowledgeDocuments.status,
        normalizedContent: knowledgeDocuments.normalizedContent,
        contentHash: knowledgeDocuments.contentHash,
        createdAt: knowledgeDocuments.createdAt,
        updatedAt: knowledgeDocuments.updatedAt,
        deletedAt: knowledgeDocuments.deletedAt,
        chunkCount,
      })
      .from(knowledgeDocuments)
      .leftJoin(
        knowledgeChunks,
        eq(knowledgeChunks.documentId, knowledgeDocuments.id),
      )
      .where(
        and(
          eq(knowledgeDocuments.id, documentId),
          eq(knowledgeDocuments.actorId, actorId),
          eq(knowledgeDocuments.status, "ACTIVE"),
        ),
      )
      .groupBy(knowledgeDocuments.id)
      .limit(1);
    return row;
  }

  public listOwned(actorId: string, limit: number) {
    return this.database.db
      .select({
        id: knowledgeDocuments.id,
        actorId: knowledgeDocuments.actorId,
        title: knowledgeDocuments.title,
        sourceType: knowledgeDocuments.sourceType,
        status: knowledgeDocuments.status,
        normalizedContent: knowledgeDocuments.normalizedContent,
        contentHash: knowledgeDocuments.contentHash,
        createdAt: knowledgeDocuments.createdAt,
        updatedAt: knowledgeDocuments.updatedAt,
        deletedAt: knowledgeDocuments.deletedAt,
        chunkCount,
      })
      .from(knowledgeDocuments)
      .leftJoin(
        knowledgeChunks,
        eq(knowledgeChunks.documentId, knowledgeDocuments.id),
      )
      .where(
        and(
          eq(knowledgeDocuments.actorId, actorId),
          eq(knowledgeDocuments.status, "ACTIVE"),
        ),
      )
      .groupBy(knowledgeDocuments.id)
      .orderBy(desc(knowledgeDocuments.createdAt), desc(knowledgeDocuments.id))
      .limit(limit);
  }

  public async deleteOwned(actorId: string, documentId: string, now: Date) {
    const [row] = await this.database.db
      .update(knowledgeDocuments)
      .set({ status: "DELETED", deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(knowledgeDocuments.id, documentId),
          eq(knowledgeDocuments.actorId, actorId),
          eq(knowledgeDocuments.status, "ACTIVE"),
        ),
      )
      .returning({ id: knowledgeDocuments.id });
    return row;
  }

  public listOwnedActiveChunks(actorId: string, documentId: string) {
    return this.database.db
      .select({
        id: knowledgeChunks.id,
        ordinal: knowledgeChunks.ordinal,
        content: knowledgeChunks.content,
        contentHash: knowledgeChunks.contentHash,
      })
      .from(knowledgeChunks)
      .innerJoin(
        knowledgeDocuments,
        eq(knowledgeDocuments.id, knowledgeChunks.documentId),
      )
      .where(
        and(
          eq(knowledgeDocuments.id, documentId),
          eq(knowledgeDocuments.actorId, actorId),
          eq(knowledgeDocuments.status, "ACTIVE"),
        ),
      )
      .orderBy(knowledgeChunks.ordinal);
  }
}
