import type { ExecutionContext } from "../domain/tool-context.js";
import type { RegisteredTool } from "../registry/tool-definition.js";

export function requiresApproval(tool: RegisteredTool): boolean {
  return tool.riskLevel === "DESTRUCTIVE" || tool.approvalPolicy === "REQUIRED";
}

export function hasValidApproval(
  tool: RegisteredTool,
  context: ExecutionContext,
): boolean {
  const approval = context.approval;
  return (
    approval?.status === "approved" &&
    approval.approvedTool === tool.name &&
    approval.approvedActorId === context.actorId &&
    approval.approvalId.length > 0 &&
    approval.approvedBy.length > 0
  );
}
