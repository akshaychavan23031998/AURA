import { randomUUID } from "node:crypto";

import { loadConfig } from "../config/index.js";
import { createDatabaseClient } from "../db/client.js";
import { createMemoryEmbeddingClient } from "../memory/memory-embedding-client.js";
import { KnowledgeEmbeddingRepository } from "./knowledge-embedding-repository.js";
import { KnowledgeRepository } from "./knowledge-repository.js";
import { KnowledgeService } from "./knowledge-service.js";

const config = loadConfig();
if (!config.memoryEmbeddings.enabled)
  throw new Error("Embeddings must be enabled for knowledge backfill");
const batchSize = Number(process.argv[2] ?? 25);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
  throw new Error("Backfill batch size must be between 1 and 100");

const database = createDatabaseClient(config);
try {
  const service = new KnowledgeService(
    new KnowledgeRepository(database),
    undefined,
    {
      client: createMemoryEmbeddingClient(config.memoryEmbeddings),
      repository: new KnowledgeEmbeddingRepository(database),
      concurrency: 2,
      searchLimit: config.knowledgeSearch.limit,
      minimumSimilarity: config.knowledgeSearch.minimumSimilarity,
    },
  );
  const result = await service.backfill(batchSize, randomUUID());
  process.stdout.write(
    `Knowledge embedding backfill: processed=${result.processed} embedded=${result.embedded} failed=${result.failed}\n`,
  );
  if (result.failed > 0) process.exitCode = 1;
} finally {
  await database.close();
}
