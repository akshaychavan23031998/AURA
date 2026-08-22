import { z } from "zod";

import type { AuthenticatedFetch } from "../auth/authenticated-fetch";
import { resolveGatewayHttpUrl } from "../voice/gateway-url";

const workflowStatusSchema = z.enum([
  "READY",
  "RUNNING",
  "AWAITING_APPROVAL",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "RECOVERY_REQUIRED",
]);

const workflowStepStatusSchema = z.enum([
  "READY",
  "BLOCKED",
  "RUNNING",
  "AWAITING_APPROVAL",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
  "RECOVERY_REQUIRED",
]);

const workflowStepKindSchema = z.enum([
  "tool",
  "memory_read",
  "memory_search",
  "knowledge_search",
]);

const workflowSummarySchema = z
  .object({
    id: z.uuid(),
    goal: z.string().min(1).max(1024),
    status: workflowStatusSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    cancelledAt: z.iso.datetime().nullable(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict();

const workflowStepSchema = z
  .object({
    stepKey: z.string().min(1).max(64),
    kind: workflowStepKindSchema,
    ordinal: z.number().int().min(0).max(7),
    status: workflowStepStatusSchema,
    dependsOn: z.array(z.string().min(1).max(64)).max(7),
    payload: z.record(z.string(), z.unknown()),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    errorCode: z.string().min(1).max(64).nullable(),
    hasResult: z.boolean(),
  })
  .strict();

const workflowSchema = workflowSummarySchema
  .extend({
    steps: z.array(workflowStepSchema).max(8),
  })
  .strict();

const listResponseSchema = z
  .object({
    workflows: z.array(workflowSummarySchema).max(50),
  })
  .strict();

const workflowResponseSchema = z
  .object({
    workflow: workflowSchema,
  })
  .strict();

export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;
export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>;
export type WorkflowStepKind = z.infer<typeof workflowStepKindSchema>;
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type Workflow = z.infer<typeof workflowSchema>;

export class WorkflowApi {
  public constructor(
    private readonly http: Pick<AuthenticatedFetch, "request">,
    private readonly baseUrl: URL = resolveGatewayHttpUrl(),
  ) {}

  public async list(limit = 20): Promise<WorkflowSummary[]> {
    const url = new URL("api/v1/workflows", this.baseUrl);
    url.searchParams.set("limit", String(limit));

    const response = await this.http.request(url);

    return parse(listResponseSchema, await response.json()).workflows;
  }

  public async get(workflowId: string): Promise<Workflow> {
    const response = await this.http.request(
      workflowUrl(this.baseUrl, workflowId),
    );

    return parse(workflowResponseSchema, await response.json()).workflow;
  }

  public async run(workflowId: string): Promise<Workflow> {
    const response = await this.http.request(
      workflowActionUrl(this.baseUrl, workflowId, "run"),
      {
        method: "POST",
      },
    );

    return parse(workflowResponseSchema, await response.json()).workflow;
  }

  public async recover(workflowId: string): Promise<Workflow> {
    const response = await this.http.request(
      workflowActionUrl(this.baseUrl, workflowId, "recover"),
      {
        method: "POST",
      },
    );

    return parse(workflowResponseSchema, await response.json()).workflow;
  }

  public async cancel(workflowId: string): Promise<Workflow> {
    const response = await this.http.request(
      workflowActionUrl(this.baseUrl, workflowId, "cancel"),
      {
        method: "POST",
      },
    );

    return parse(workflowResponseSchema, await response.json()).workflow;
  }
}

function workflowUrl(baseUrl: URL, workflowId: string): URL {
  return new URL(`api/v1/workflows/${encodeURIComponent(workflowId)}`, baseUrl);
}

function workflowActionUrl(
  baseUrl: URL,
  workflowId: string,
  action: "run" | "recover" | "cancel",
): URL {
  return new URL(
    `api/v1/workflows/${encodeURIComponent(workflowId)}/${action}`,
    baseUrl,
  );
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) throw new Error("Invalid workflow response");

  return parsed.data;
}
