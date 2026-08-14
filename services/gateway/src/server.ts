import { createApp } from "./app/create-app.js";
import { loadConfig } from "./config/index.js";
import { createDatabaseClient } from "./db/client.js";
import { registerShutdownHandlers } from "./lifecycle/shutdown.js";

async function startServer(): Promise<void> {
  const config = loadConfig();
  const database = createDatabaseClient(config);
  let app: FastifyInstance | undefined;

  try {
    await database.check();
    app = await createApp({ config, database });
    registerShutdownHandlers(app);
    await app.listen({ host: config.server.host, port: config.server.port });
    app.log.info(
      { host: config.server.host, port: config.server.port },
      "Gateway started successfully",
    );
  } catch (error) {
    process.exitCode = 1;
    if (app === undefined) {
      console.error("Gateway startup failed before listening");
      await database.close();
    } else {
      app.log.fatal({ err: error }, "Gateway startup failed");
      await app.close();
    }
  }
}

void startServer();
import type { FastifyInstance } from "fastify";
