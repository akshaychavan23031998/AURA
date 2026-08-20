import { randomUUID } from "node:crypto";

import { loadConfig } from "../config/index.js";
import { createDatabaseClient } from "../db/client.js";
import { createMemoryEmbeddingClient } from "./memory-embedding-client.js";
import { MemoryEmbeddingRepository } from "./memory-embedding-repository.js";
import { MemoryRepository } from "./memory-repository.js";
import { MemoryService } from "./memory-service.js";

const config = loadConfig();
if (!config.memoryEmbeddings.enabled)
  throw new Error("Memory embeddings must be enabled for backfill");
const batchSize = Number(process.argv[2] ?? 25);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
  throw new Error("Backfill batch size must be between 1 and 100");

const database = createDatabaseClient(config);
try {
  const service = new MemoryService(new MemoryRepository(database), {
    client: createMemoryEmbeddingClient(config.memoryEmbeddings),
    repository: new MemoryEmbeddingRepository(database),
    searchLimit: config.memoryEmbeddings.searchLimit,
    minimumSimilarity: config.memoryEmbeddings.minimumSimilarity,
  });
  const result = await service.backfill(batchSize, randomUUID());
  process.stdout.write(
    `Memory embedding backfill: scanned=${result.scanned} embedded=${result.embedded} failed=${result.failed}\n`,
  );
  if (result.failed > 0) process.exitCode = 1;
} finally {
  await database.close();
}
