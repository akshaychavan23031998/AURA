export interface ApprovalAssertion {
  readonly status: "approved";
  readonly approvalId: string;
  readonly approvedActorId: string;
  readonly approvedTool: string;
  readonly approvedToolVersion: number;
  readonly inputDigest: string;
}

export interface ExecutionContext {
  readonly requestId: string;
  readonly actorId: string;
  readonly conversationId?: string;
  readonly grantedPermissions: readonly string[];
  readonly approval?: ApprovalAssertion;
  readonly idempotencyKey?: string;
}
