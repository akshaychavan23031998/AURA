import {
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
