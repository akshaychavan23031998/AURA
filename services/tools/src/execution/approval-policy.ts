import type { ExecutionContext } from "../domain/tool-context.js";
import type { RegisteredTool } from "../registry/tool-definition.js";
import { actionDigest } from "./action-digest.js";

export function requiresApproval(tool: RegisteredTool): boolean {
  return tool.riskLevel === "DESTRUCTIVE" || tool.approvalPolicy === "REQUIRED";
}

export function hasValidApproval(
  tool: RegisteredTool,
  context: ExecutionContext,
  input: unknown,
): boolean {
  const approval = context.approval;
  return (
    approval?.status === "approved" &&
    approval.approvedTool === tool.name &&
    approval.approvedToolVersion === tool.version &&
    approval.approvedActorId === context.actorId &&
    approval.approvalId.length > 0 &&
    approval.inputDigest === actionDigest(tool.name, tool.version, input)
  );
}
