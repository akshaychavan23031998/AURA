import { z } from "zod";

import type { AuthenticatedFetch } from "../auth/authenticated-fetch";
import { resolveGatewayHttpUrl } from "../voice/gateway-url";

const metadataSchema = z
  .object({
    id: z.uuid(),
    title: z.string().max(200),
    sourceType: z.literal("manual_text"),
    chunkCount: z.number().int().min(1).max(128),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
const documentSchema = metadataSchema.extend({ content: z.string() }).strict();
const resultSchema = z
  .object({
    documentId: z.uuid(),
    chunkId: z.uuid(),
    title: z.string().max(200),
    content: z.string().max(2000),
    ordinal: z.number().int().min(0).max(127),
  })
  .strict();
const listSchema = z
  .object({ documents: z.array(metadataSchema).max(50) })
  .strict();
const documentResponseSchema = z.object({ document: documentSchema }).strict();
const createResponseSchema = z.object({ document: metadataSchema }).strict();
const searchResponseSchema = z
  .object({ results: z.array(resultSchema).max(10) })
  .strict();

export type KnowledgeMetadata = z.infer<typeof metadataSchema>;
export type KnowledgeDocument = z.infer<typeof documentSchema>;
export type KnowledgeSearchResult = z.infer<typeof resultSchema>;

export class KnowledgeApi {
  public constructor(
    private readonly http: Pick<AuthenticatedFetch, "request">,
    private readonly baseUrl: URL = resolveGatewayHttpUrl(),
  ) {}

  public async list(): Promise<KnowledgeMetadata[]> {
    const response = await this.http.request(
      new URL("api/v1/knowledge/documents", this.baseUrl),
    );
    return parse(listSchema, await response.json()).documents;
  }

  public async get(documentId: string): Promise<KnowledgeDocument> {
    const response = await this.http.request(
      new URL(
        `api/v1/knowledge/documents/${encodeURIComponent(documentId)}`,
        this.baseUrl,
      ),
    );
    return parse(documentResponseSchema, await response.json()).document;
  }

  public async create(input: {
    readonly title: string;
    readonly content: string;
  }): Promise<KnowledgeMetadata> {
    const response = await this.http.request(
      new URL("api/v1/knowledge/documents", this.baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: input.title, content: input.content }),
      },
    );
    return parse(createResponseSchema, await response.json()).document;
  }

  public async delete(documentId: string): Promise<void> {
    await this.http.request(
      new URL(
        `api/v1/knowledge/documents/${encodeURIComponent(documentId)}`,
        this.baseUrl,
      ),
      { method: "DELETE" },
    );
  }

  public async search(query: string): Promise<KnowledgeSearchResult[]> {
    const response = await this.http.request(
      new URL("api/v1/knowledge/search", this.baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      },
    );
    return parse(searchResponseSchema, await response.json()).results;
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid knowledge response");
  return parsed.data;
}
