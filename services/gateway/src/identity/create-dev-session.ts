import { z } from "zod";

import { loadAuthConfig, loadDatabaseConfig } from "../config/index.js";
import { createDatabaseClient } from "../db/client.js";
import { IdentityRepository } from "./repositories.js";
import { SessionService } from "./session-service.js";

const index = process.argv.indexOf("--user-id");
const parsed = z
  .uuid()
  .safeParse(index === -1 ? undefined : process.argv[index + 1]);
if (!parsed.success) {
  console.error("Usage: pnpm identity:dev-session -- --user-id <uuid>");
  process.exitCode = 1;
} else {
  const auth = loadAuthConfig();
  const database = createDatabaseClient({ database: loadDatabaseConfig() });
  try {
    const tokens = await new SessionService(
      new IdentityRepository(database),
      auth,
    ).create(parsed.data);
    process.stdout.write(`${JSON.stringify(tokens)}\n`);
  } finally {
    await database.close();
  }
}
