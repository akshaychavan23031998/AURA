"use client";

import { useEffect, useState } from "react";

export interface ApprovalView {
  approvalId: string;
  title: string;
  preview: string;
  status: "PENDING" | "REJECTED" | "CONSUMED" | "EXPIRED";
  expiresAt: string;
}

export function ApprovalCard({
  approval,
  busy = false,
  error,
  onApprove,
  onReject,
}: Readonly<{
  approval: ApprovalView;
  busy?: boolean;
  error?: string;
  onApprove(id: string): Promise<void>;
  onReject(id: string): Promise<void>;
}>) {
  const [renderedAt, setRenderedAt] = useState(() => Date.now());
  useEffect(() => {
    const delay = Math.min(
      2_147_483_647,
      Math.max(0, Date.parse(approval.expiresAt) - Date.now()),
    );
    const timer = window.setTimeout(() => setRenderedAt(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [approval.expiresAt]);
  const expired =
    approval.status === "EXPIRED" ||
    Date.parse(approval.expiresAt) <= renderedAt;
  const pending = approval.status === "PENDING" && !expired;
  return (
    <section
      className="approval-card"
      aria-labelledby={`approval-${approval.approvalId}`}
    >
      <h2 id={`approval-${approval.approvalId}`}>{approval.title}</h2>
      <p>{approval.preview}</p>
      <p aria-live="polite">
        {expired
          ? "Approval expired"
          : approval.status === "REJECTED"
            ? "Action rejected"
            : approval.status === "CONSUMED"
              ? "Action completed"
              : `Expires ${new Date(approval.expiresAt).toLocaleTimeString()}`}
      </p>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        disabled={!pending || busy}
        onClick={() => void onApprove(approval.approvalId)}
        aria-label="Approve action"
      >
        {busy ? "Working…" : "Approve"}
      </button>
      <button
        type="button"
        disabled={!pending || busy}
        onClick={() => void onReject(approval.approvalId)}
        aria-label="Reject action"
      >
        Reject
      </button>
    </section>
  );
}
