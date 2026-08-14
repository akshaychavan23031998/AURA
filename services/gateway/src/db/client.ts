import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { DatabaseConfig } from "../config/index.js";
import * as schema from "./schema.js";

export interface DatabaseClient {
  readonly db: NodePgDatabase<typeof schema>;
  check(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabaseClient(config: {
  readonly database: DatabaseConfig;
}): DatabaseClient {
  const pool = new Pool({
    connectionString: config.database.url,
    connectionTimeoutMillis: config.database.connectTimeoutMs,
    query_timeout: config.database.queryTimeoutMs,
    max: config.database.poolMax,
  });
  return {
    db: drizzle(pool, { schema }),
    async check() {
      await pool.query("select 1 from users limit 1");
    },
    async close() {
      await pool.end();
    },
  };
}
