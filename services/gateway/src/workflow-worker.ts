import { createApp } from "./app/create-app.js";
import { loadConfig } from "./config/index.js";
import { createDatabaseClient } from "./db/client.js";
import type { WorkflowRunner } from "./workflows/workflow-executor.js";
import { WorkflowActorPolicy } from "./workflows/workflow-actor-policy.js";
import { WorkflowLeaseRepository } from "./workflows/workflow-lease-repository.js";
import { WorkflowWorker } from "./workflows/workflow-worker.js";

async function startWorker(): Promise<void> {
  const config = loadConfig();
  if (!config.workflowWorker.enabled) {
    console.error("Workflow worker is disabled");
    process.exitCode = 1;
    return;
  }
  const database = createDatabaseClient(config);
  let runner: WorkflowRunner | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await database.check();
    app = await createApp({
      config,
      database,
      onWorkflowRuntimeReady: (value) => {
        runner = value;
      },
    });
    if (runner === undefined) throw new Error("Workflow runtime unavailable");
    const worker = new WorkflowWorker(
      config.workflowWorker,
      new WorkflowLeaseRepository(database),
      new WorkflowActorPolicy(database),
      runner,
      app.log,
    );
    const stop = () => worker.stop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    app.log.info(
      { operation: "workflow_worker_start" },
      "Workflow worker started",
    );
    await worker.run();
    await app.close();
  } catch {
    process.exitCode = 1;
    if (app === undefined) {
      console.error("Workflow worker startup failed");
      await database.close();
    } else {
      app.log.error(
        { operation: "workflow_worker_failure" },
        "Workflow worker failed",
      );
      await app.close();
    }
  }
}

void startWorker();
