export interface ApprovalAssertion {
  readonly status: "approved";
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly approvedActorId: string;
  readonly approvedTool: string;
}

export interface ExecutionContext {
  readonly requestId: string;
  readonly actorId: string;
  readonly conversationId?: string;
  readonly grantedPermissions: readonly string[];
  readonly approval?: ApprovalAssertion;
  readonly idempotencyKey?: string;
}
