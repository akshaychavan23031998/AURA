import { z } from "zod";

import type { AuthenticatedFetch } from "../auth/authenticated-fetch";
import { resolveGatewayHttpUrl } from "../voice/gateway-url";

export const memoryKindSchema = z.enum([
  "preference",
  "fact",
  "instruction",
  "note",
]);
const memorySchema = z
  .object({
    id: z.uuid(),
    kind: memoryKindSchema,
    content: z.string().max(4096),
    source: z.literal("user_explicit"),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
const listSchema = z
  .object({ memories: z.array(memorySchema).max(50) })
  .strict();
const itemSchema = z.object({ memory: memorySchema }).strict();

export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type MemoryView = z.infer<typeof memorySchema>;

export class MemoryApi {
  public constructor(
    private readonly http: Pick<AuthenticatedFetch, "request">,
    private readonly baseUrl: URL = resolveGatewayHttpUrl(),
  ) {}

  public async list(kind?: MemoryKind): Promise<MemoryView[]> {
    const url = new URL("api/v1/memories", this.baseUrl);
    if (kind !== undefined) url.searchParams.set("kind", kind);
    const response = await this.http.request(url);
    return parse(listSchema, await response.json()).memories;
  }

  public async create(input: {
    readonly kind: MemoryKind;
    readonly content: string;
  }): Promise<MemoryView> {
    const response = await this.http.request(
      new URL("api/v1/memories", this.baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: input.kind, content: input.content }),
      },
    );
    return parse(itemSchema, await response.json()).memory;
  }

  public async delete(memoryId: string): Promise<void> {
    await this.http.request(
      new URL(`api/v1/memories/${encodeURIComponent(memoryId)}`, this.baseUrl),
      { method: "DELETE" },
    );
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid memory response");
  return parsed.data;
}
