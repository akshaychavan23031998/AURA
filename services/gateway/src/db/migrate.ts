import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";

import { loadDatabaseConfig } from "../config/index.js";
import { createDatabaseClient } from "./client.js";

const database = createDatabaseClient({ database: loadDatabaseConfig() });
try {
  await migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
} finally {
  await database.close();
}
