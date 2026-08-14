import { and, eq, gt } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { toolApprovals } from "../db/schema.js";

export interface NewApproval {
  actorId: string;
  toolName: string;
  toolVersion: number;
  inputDigest: string;
  input: unknown;
  request: unknown;
  title: string;
  preview: string;
  expiresAt: Date;
}

export class ApprovalRepository {
  public constructor(private readonly database: DatabaseClient) {}
  public async create(value: NewApproval) {
    const [row] = await this.database.db
      .insert(toolApprovals)
      .values({
        actorId: value.actorId,
        toolName: value.toolName,
        toolVersion: value.toolVersion,
        inputDigest: value.inputDigest,
        inputEnvelope: value.input,
        requestEnvelope: value.request,
        title: value.title,
        preview: value.preview,
        expiresAt: value.expiresAt,
      })
      .returning();
    if (!row) throw new Error("Unable to create approval");
    return row;
  }
  public async findOwned(id: string, actorId: string) {
    const [row] = await this.database.db
      .select()
      .from(toolApprovals)
      .where(and(eq(toolApprovals.id, id), eq(toolApprovals.actorId, actorId)))
      .limit(1);
    return row;
  }
  public async reject(id: string, actorId: string, now: Date) {
    const [row] = await this.database.db
      .update(toolApprovals)
      .set({ status: "REJECTED", decidedAt: now })
      .where(
        and(
          eq(toolApprovals.id, id),
          eq(toolApprovals.actorId, actorId),
          eq(toolApprovals.status, "PENDING"),
          gt(toolApprovals.expiresAt, now),
        ),
      )
      .returning();
    return row;
  }
  public async consume(id: string, actorId: string, now: Date) {
    const [row] = await this.database.db
      .update(toolApprovals)
      .set({ status: "CONSUMED", decidedAt: now, consumedAt: now })
      .where(
        and(
          eq(toolApprovals.id, id),
          eq(toolApprovals.actorId, actorId),
          eq(toolApprovals.status, "PENDING"),
          gt(toolApprovals.expiresAt, now),
        ),
      )
      .returning();
    return row;
  }
}
