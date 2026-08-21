import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
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
  "file_txt",
  "file_pdf",
  "file_docx",
]);
export const knowledgeStatus = pgEnum("knowledge_status", [
  "ACTIVE",
  "DELETED",
]);
export const workflowStatus = pgEnum("workflow_status", [
  "READY",
  "RUNNING",
  "AWAITING_APPROVAL",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export const workflowStepKind = pgEnum("workflow_step_kind", [
  "tool",
  "memory_read",
  "memory_search",
  "knowledge_search",
]);
export const workflowStepStatus = pgEnum("workflow_step_status", [
  "READY",
  "BLOCKED",
  "RUNNING",
  "AWAITING_APPROVAL",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
]);
export const workflowExecutionStatus = pgEnum("workflow_execution_status", [
  "RUNNING",
  "AWAITING_APPROVAL",
  "SUCCEEDED",
  "FAILED",
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

export const knowledgeChunkEmbeddings = pgTable(
  "knowledge_chunk_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => knowledgeChunks.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    embedding: vector384("embedding").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("knowledge_chunk_embeddings_chunk_model_uidx").on(
      table.chunkId,
      table.model,
    ),
    index("knowledge_chunk_embeddings_model_idx").on(table.model),
    check(
      "knowledge_chunk_embeddings_model_length_check",
      sql`char_length(${table.model}) between 1 and 128`,
    ),
  ],
);

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    goal: text("goal").notNull(),
    status: workflowStatus("status").notNull().default("READY"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "workflows_goal_length_check",
      sql`char_length(${table.goal}) between 1 and 1024`,
    ),
    index("workflows_actor_created_idx").on(table.actorId, table.createdAt),
    index("workflows_actor_status_idx").on(table.actorId, table.status),
  ],
);

export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    stepKey: varchar("step_key", { length: 64 }).notNull(),
    kind: workflowStepKind("kind").notNull(),
    ordinal: integer("ordinal").notNull(),
    status: workflowStepStatus("status").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("workflow_steps_workflow_key_uidx").on(
      table.workflowId,
      table.stepKey,
    ),
    uniqueIndex("workflow_steps_workflow_ordinal_uidx").on(
      table.workflowId,
      table.ordinal,
    ),
    uniqueIndex("workflow_steps_workflow_id_uidx").on(
      table.workflowId,
      table.id,
    ),
    check(
      "workflow_steps_key_length_check",
      sql`char_length(${table.stepKey}) between 1 and 64`,
    ),
    check(
      "workflow_steps_ordinal_check",
      sql`${table.ordinal} between 0 and 7`,
    ),
  ],
);

export const workflowStepDependencies = pgTable(
  "workflow_step_dependencies",
  {
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").notNull(),
    dependsOnStepId: uuid("depends_on_step_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "workflow_step_dependencies_pk",
      columns: [table.workflowId, table.stepId, table.dependsOnStepId],
    }),
    foreignKey({
      name: "workflow_step_dependencies_step_fk",
      columns: [table.workflowId, table.stepId],
      foreignColumns: [workflowSteps.workflowId, workflowSteps.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "workflow_step_dependencies_depends_fk",
      columns: [table.workflowId, table.dependsOnStepId],
      foreignColumns: [workflowSteps.workflowId, workflowSteps.id],
    }).onDelete("cascade"),
    check(
      "workflow_step_dependencies_not_self_check",
      sql`${table.stepId} <> ${table.dependsOnStepId}`,
    ),
  ],
);

export const workflowStepExecutions = pgTable(
  "workflow_step_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    stepId: uuid("step_id")
      .notNull()
      .references(() => workflowSteps.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull().default(1),
    status: workflowExecutionStatus("status").notNull(),
    approvalId: uuid("approval_id").references(() => toolApprovals.id, {
      onDelete: "restrict",
    }),
    result: jsonb("result"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("workflow_step_executions_step_attempt_uidx").on(
      table.stepId,
      table.attemptNumber,
    ),
    check(
      "workflow_step_executions_attempt_check",
      sql`${table.attemptNumber} = 1`,
    ),
    check(
      "workflow_step_executions_error_code_check",
      sql`${table.errorCode} is null or char_length(${table.errorCode}) between 1 and 64`,
    ),
  ],
);
