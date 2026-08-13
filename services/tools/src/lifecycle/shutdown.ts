import type { FastifyInstance } from "fastify";

export function registerShutdownHandlers(app: FastifyInstance): () => void {
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "Tool Service shutdown started");
    try {
      await app.close();
      app.log.info("Tool Service shutdown completed");
    } catch (error) {
      app.log.error({ err: error }, "Tool Service shutdown failed");
      process.exitCode = 1;
    }
  };
  const onSigint = (): void => void shutdown("SIGINT");
  const onSigterm = (): void => void shutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return () => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  };
}
