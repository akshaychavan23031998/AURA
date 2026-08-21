import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiFailure } from "../auth/authenticated-fetch";
import { MemoryPanel } from "./memory-panel";

const memory = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "preference" as const,
  content: "Prefer concise answers",
  source: "user_explicit" as const,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};

function api(rows = [memory]) {
  return {
    list: vi.fn().mockResolvedValue(rows),
    create: vi.fn().mockResolvedValue(memory),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe("MemoryPanel", () => {
  it("loads, validates, explicitly creates, and never persists content", async () => {
    const client = api();
    const local = vi.spyOn(Storage.prototype, "setItem");
    render(<MemoryPanel api={client} />);
    expect(await screen.findByText("Prefer concise answers")).toBeVisible();
    const submit = screen.getByRole("button", { name: "Save memory" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Content"), {
      target: { value: "Use dark mode" },
    });
    fireEvent.change(screen.getByLabelText("Kind"), {
      target: { value: "instruction" },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(client.create).toHaveBeenCalledWith({
        kind: "instruction",
        content: "Use dark mode",
      }),
    );
    expect(local).not.toHaveBeenCalled();
    local.mockRestore();
  });

  it("blocks duplicate submission while pending", async () => {
    const client = api([]);
    client.create.mockReturnValueOnce(new Promise(() => undefined));
    render(<MemoryPanel api={client} />);
    await screen.findByText("No explicit saved memories found.");
    fireEvent.change(screen.getByLabelText("Content"), {
      target: { value: "One write" },
    });
    const submit = screen.getByRole("button", { name: "Save memory" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(client.create).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("requires a second deliberate delete action", async () => {
    const client = api();
    render(<MemoryPanel api={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(client.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(client.delete).toHaveBeenCalledWith(memory.id));
  });

  it("renders permission failures without leaking exception details", async () => {
    const client = api();
    client.list.mockRejectedValueOnce(new ApiFailure(403, "request-failed"));
    render(<MemoryPanel api={client} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You do not have permission",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("request-failed");
  });
});
