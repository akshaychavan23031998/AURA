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
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    max: 10,
  });
  return {
    db: drizzle(pool, { schema }),
    async check() {
      await pool.query("select 1");
    },
    async close() {
      await pool.end();
    },
  };
}
