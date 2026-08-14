import type { AuthenticatedFetch } from "../auth/authenticated-fetch";
import { z } from "zod";

const approvalSchema = z
  .object({
    approvalId: z.string().uuid(),
    toolName: z.string(),
    toolVersion: z.number().int().positive(),
    title: z.string(),
    preview: z.string(),
    status: z.enum(["PENDING", "REJECTED", "CONSUMED", "EXPIRED"]),
    expiresAt: z.string(),
  })
  .strict();
const decisionSchema = z
  .object({ approval: approvalSchema, result: z.unknown().optional() })
  .strict();
export type ApprovalDecision = z.infer<typeof decisionSchema>;

export class ApprovalApi {
  public constructor(
    private readonly http: AuthenticatedFetch,
    private readonly gateway: URL,
  ) {}
  public approve(id: string): Promise<ApprovalDecision> {
    return this.decide(id, "approve");
  }
  public reject(id: string): Promise<ApprovalDecision> {
    return this.decide(id, "reject");
  }
  private async decide(id: string, decision: "approve" | "reject") {
    const safeId = encodeURIComponent(id);
    const response = await this.http.request(
      new URL(`/api/v1/approvals/${safeId}/${decision}`, this.gateway),
      { method: "POST" },
    );
    const body: unknown = await response.json();
    const normalized = decision === "reject" ? { approval: body } : body;
    return decisionSchema.parse(normalized);
  }
}
