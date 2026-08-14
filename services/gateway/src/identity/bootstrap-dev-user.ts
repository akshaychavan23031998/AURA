import { loadDatabaseConfig } from "../config/index.js";
import { createDatabaseClient } from "../db/client.js";
import { IdentityRepository } from "./repositories.js";

if (process.env.NODE_ENV === "production")
  throw new Error("Development identity bootstrap is disabled in production");

const database = createDatabaseClient({ database: loadDatabaseConfig() });
try {
  process.stdout.write(
    `${await new IdentityRepository(database).bootstrapDevelopmentUser()}\n`,
  );
} finally {
  await database.close();
}
