export interface RealtimeApprovalListener {
  approved(responseText: string): void;
  rejected(): void;
  failed(): void;
}

export class ApprovalRealtimeRegistry {
  private readonly listeners = new Map<string, RealtimeApprovalListener>();

  public attach(approvalId: string, listener: RealtimeApprovalListener): void {
    this.listeners.set(approvalId, listener);
  }

  public detach(approvalId: string, listener: RealtimeApprovalListener): void {
    if (this.listeners.get(approvalId) === listener)
      this.listeners.delete(approvalId);
  }

  public approved(approvalId: string, responseText: string): void {
    const listener = this.take(approvalId);
    listener?.approved(responseText);
  }

  public rejected(approvalId: string): void {
    const listener = this.take(approvalId);
    listener?.rejected();
  }

  public failed(approvalId: string): void {
    const listener = this.take(approvalId);
    listener?.failed();
  }

  private take(approvalId: string): RealtimeApprovalListener | undefined {
    const listener = this.listeners.get(approvalId);
    this.listeners.delete(approvalId);
    return listener;
  }
}
