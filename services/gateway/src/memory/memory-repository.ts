import { and, desc, eq } from "drizzle-orm";

import type { DatabaseClient } from "../db/client.js";
import { userMemories } from "../db/schema.js";

export type MemoryKind = "preference" | "fact" | "instruction" | "note";

export interface CreateMemoryValue {
  readonly kind: MemoryKind;
  readonly content: string;
}

export interface ListMemoryOptions {
  readonly limit: number;
  readonly kind?: MemoryKind;
}

export class MemoryRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async create(actorId: string, value: CreateMemoryValue) {
    const [row] = await this.database.db
      .insert(userMemories)
      .values({ actorId, kind: value.kind, content: value.content })
      .returning();
    if (row === undefined) throw new Error("Memory persistence failed");
    return row;
  }

  public async getOwned(actorId: string, memoryId: string) {
    const [row] = await this.database.db
      .select()
      .from(userMemories)
      .where(
        and(
          eq(userMemories.id, memoryId),
          eq(userMemories.actorId, actorId),
          eq(userMemories.status, "ACTIVE"),
        ),
      )
      .limit(1);
    return row;
  }

  public async listOwned(actorId: string, options: ListMemoryOptions) {
    const ownership = and(
      eq(userMemories.actorId, actorId),
      eq(userMemories.status, "ACTIVE"),
      options.kind === undefined
        ? undefined
        : eq(userMemories.kind, options.kind),
    );
    return this.database.db
      .select()
      .from(userMemories)
      .where(ownership)
      .orderBy(desc(userMemories.createdAt), desc(userMemories.id))
      .limit(options.limit);
  }

  public async deleteOwned(actorId: string, memoryId: string, now: Date) {
    const [row] = await this.database.db
      .update(userMemories)
      .set({ status: "DELETED", deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(userMemories.id, memoryId),
          eq(userMemories.actorId, actorId),
          eq(userMemories.status, "ACTIVE"),
        ),
      )
      .returning({ id: userMemories.id });
    return row;
  }
}
