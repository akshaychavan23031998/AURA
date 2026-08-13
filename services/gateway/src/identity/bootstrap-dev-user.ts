import { loadDatabaseConfig } from "../config/index.js";
import { createDatabaseClient } from "../db/client.js";
import { IdentityRepository } from "./repositories.js";

const database = createDatabaseClient({ database: loadDatabaseConfig() });
try {
  process.stdout.write(
    `${await new IdentityRepository(database).bootstrapDevelopmentUser()}\n`,
  );
} finally {
  await database.close();
}
