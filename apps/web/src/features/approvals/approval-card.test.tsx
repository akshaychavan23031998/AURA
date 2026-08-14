import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard, type ApprovalView } from "./approval-card";

const pending: ApprovalView = {
  approvalId: "a",
  title: "Confirm action",
  preview: "Safe preview",
  status: "PENDING",
  expiresAt: "2999-01-01T00:00:00.000Z",
};

describe("ApprovalCard", () => {
  it("requires an explicit approve or reject click", () => {
    const approve = vi.fn(() => Promise.resolve());
    const reject = vi.fn(() => Promise.resolve());
    render(
      <ApprovalCard approval={pending} onApprove={approve} onReject={reject} />,
    );
    expect(approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve action" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject action" }));
    expect(approve).toHaveBeenCalledWith("a");
    expect(reject).toHaveBeenCalledWith("a");
  });
  it.each(["EXPIRED", "REJECTED", "CONSUMED"] as const)(
    "disables decisions for %s",
    (status) => {
      render(
        <ApprovalCard
          approval={{ ...pending, status }}
          onApprove={vi.fn()}
          onReject={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Approve action" }),
      ).toBeDisabled();
    },
  );
  it("shows loading and safe errors", () => {
    render(
      <ApprovalCard
        approval={pending}
        busy
        error="Session expired"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Session expired");
    expect(
      screen.getByRole("button", { name: "Approve action" }),
    ).toBeDisabled();
  });
});
