import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userStatus = pgEnum("user_status", ["ACTIVE", "DISABLED"]);
export const externalIdentityProvider = pgEnum("external_identity_provider", [
  "google",
]);
export const approvalStatus = pgEnum("approval_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CONSUMED",
  "EXPIRED",
]);
export const memoryKind = pgEnum("memory_kind", [
  "preference",
  "fact",
  "instruction",
  "note",
]);
export const memorySource = pgEnum("memory_source", ["user_explicit"]);
export const memoryStatus = pgEnum("memory_status", ["ACTIVE", "DELETED"]);
export const knowledgeSourceType = pgEnum("knowledge_source_type", [
  "manual_text",
]);
export const knowledgeStatus = pgEnum("knowledge_status", [
  "ACTIVE",
  "DELETED",
]);
const vector384 = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(384)",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) =>
    value
      .slice(1, -1)
      .split(",")
      .map((entry) => Number(entry)),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: userStatus("status").notNull().default("ACTIVE"),
  developmentKey: text("development_key").unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedById: uuid("replaced_by_id"),
  },
  (table) => [
    uniqueIndex("refresh_tokens_hash_uidx").on(table.tokenHash),
    index("refresh_tokens_session_id_idx").on(table.sessionId),
  ],
);

export const externalIdentities = pgTable(
  "external_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: externalIdentityProvider("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    emailAtLinkTime: text("email_at_link_time"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("external_identities_provider_subject_uidx").on(
      table.provider,
      table.providerSubject,
    ),
    index("external_identities_user_id_idx").on(table.userId),
  ],
);

export const toolApprovals = pgTable(
  "tool_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    toolVersion: integer("tool_version").notNull(),
    inputDigest: text("input_digest").notNull(),
    inputEnvelope: jsonb("input_envelope").notNull(),
    requestEnvelope: jsonb("request_envelope").notNull(),
    title: text("title").notNull(),
    preview: text("preview").notNull(),
    status: approvalStatus("status").notNull().default("PENDING"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    index("tool_approvals_actor_status_idx").on(table.actorId, table.status),
    index("tool_approvals_expires_at_idx").on(table.expiresAt),
  ],
);

export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: externalIdentityProvider("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    grantedScopes: text("granted_scopes").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_credentials_user_provider_uidx").on(
      table.userId,
      table.provider,
    ),
    uniqueIndex("provider_credentials_provider_subject_uidx").on(
      table.provider,
      table.providerSubject,
    ),
  ],
);

export const userMemories = pgTable(
  "user_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: memoryKind("kind").notNull(),
    content: text("content").notNull(),
    source: memorySource("source").notNull().default("user_explicit"),
    status: memoryStatus("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "user_memories_content_length_check",
      sql`char_length(${table.content}) between 1 and 4096`,
    ),
    index("user_memories_actor_created_idx").on(table.actorId, table.createdAt),
    index("user_memories_actor_status_idx").on(table.actorId, table.status),
  ],
);

export const userMemoryEmbeddings = pgTable(
  "user_memory_embeddings",
  {
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => userMemories.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    embedding: vector384("embedding").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("user_memory_embeddings_memory_model_uidx").on(
      table.memoryId,
      table.model,
    ),
    index("user_memory_embeddings_model_idx").on(table.model),
    check(
      "user_memory_embeddings_model_length_check",
      sql`char_length(${table.model}) between 1 and 128`,
    ),
  ],
);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sourceType: knowledgeSourceType("source_type")
      .notNull()
      .default("manual_text"),
    status: knowledgeStatus("status").notNull().default("ACTIVE"),
    normalizedContent: text("normalized_content").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "knowledge_documents_title_length_check",
      sql`char_length(${table.title}) between 1 and 200`,
    ),
    check(
      "knowledge_documents_content_bytes_check",
      sql`octet_length(${table.normalizedContent}) between 1 and 131072`,
    ),
    check(
      "knowledge_documents_content_hash_check",
      sql`char_length(${table.contentHash}) = 64`,
    ),
    index("knowledge_documents_actor_created_idx").on(
      table.actorId,
      table.createdAt,
    ),
    index("knowledge_documents_actor_status_idx").on(
      table.actorId,
      table.status,
    ),
  ],
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("knowledge_chunks_document_ordinal_uidx").on(
      table.documentId,
      table.ordinal,
    ),
    check(
      "knowledge_chunks_ordinal_check",
      sql`${table.ordinal} between 0 and 127`,
    ),
    check(
      "knowledge_chunks_content_length_check",
      sql`char_length(${table.content}) between 1 and 2000`,
    ),
    check(
      "knowledge_chunks_content_hash_check",
      sql`char_length(${table.contentHash}) = 64`,
    ),
    index("knowledge_chunks_document_idx").on(table.documentId),
  ],
);
