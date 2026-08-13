import { createApp } from "./app/create-app.js";
import { loadConfig } from "./config/index.js";
import { registerShutdownHandlers } from "./lifecycle/shutdown.js";

async function startServer(): Promise<void> {
  const config = loadConfig();
  const app = await createApp({ config });
  registerShutdownHandlers(app);

  try {
    await app.listen({ host: config.server.host, port: config.server.port });
    app.log.info(
      { host: config.server.host, port: config.server.port },
      "Gateway started successfully",
    );
  } catch (error) {
    app.log.fatal({ err: error }, "Gateway startup failed");
    process.exitCode = 1;
    await app.close();
  }
}

void startServer();
