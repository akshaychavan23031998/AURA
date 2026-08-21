import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { KnowledgePanel } from "./knowledge-panel";
import type { KnowledgeMetadata } from "./knowledge-api";

const metadata: KnowledgeMetadata = {
  id: "00000000-0000-4000-8000-000000000010",
  title: "Architecture",
  sourceType: "manual_text" as const,
  chunkCount: 2,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};
const knowledgeDocument = {
  ...metadata,
  content: "Gateway owns authorization.",
};

function api(rows = [metadata]) {
  return {
    list: vi.fn().mockResolvedValue(rows),
    get: vi.fn().mockResolvedValue(knowledgeDocument),
    create: vi.fn().mockResolvedValue(metadata),
    upload: vi.fn().mockResolvedValue(metadata),
    delete: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
  };
}

describe("KnowledgePanel", () => {
  it("ingests manual text, views a document, and keeps content ephemeral", async () => {
    const client = api();
    const persistentWrite = vi.spyOn(Storage.prototype, "setItem");
    render(<KnowledgePanel api={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "View" }));
    expect(
      await screen.findByText("Gateway owns authorization."),
    ).toBeVisible();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Release notes" },
    });
    fireEvent.change(screen.getByLabelText("Content"), {
      target: { value: "Deploy only after review." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add document" }));
    await waitFor(() =>
      expect(client.create).toHaveBeenCalledWith({
        title: "Release notes",
        content: "Deploy only after review.",
      }),
    );
    expect(persistentWrite).not.toHaveBeenCalled();
    persistentWrite.mockRestore();
  });

  it("searches with the query only and renders a truthful no-match", async () => {
    const client = api([]);
    render(<KnowledgePanel api={client} />);
    await screen.findByText("No knowledge documents found.");
    fireEvent.change(screen.getByLabelText("Search query"), {
      target: { value: "deployment" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(client.search).toHaveBeenCalledWith("deployment"),
    );
    expect(
      screen.getByText("No matching saved knowledge was found."),
    ).toBeVisible();
  });

  it("requires explicit confirmation before deleting a document", async () => {
    const client = api();
    render(<KnowledgePanel api={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(client.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(client.delete).toHaveBeenCalledWith(metadata.id),
    );
  });

  it("renders bounded semantic matches without provider internals", async () => {
    const client = api([]);
    client.search.mockResolvedValueOnce([
      {
        documentId: metadata.id,
        chunkId: "00000000-0000-4000-8000-000000000020",
        title: "Architecture",
        content: "Gateway owns authorization.",
        ordinal: 0,
      },
    ]);
    render(<KnowledgePanel api={client} />);
    fireEvent.change(screen.getByLabelText("Search query"), {
      target: { value: "authorization" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(
      await screen.findByText("Gateway owns authorization."),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(/vector|similarity|model/i);
  });

  it("uploads explicitly, blocks a duplicate, keeps the file ephemeral, and refreshes", async () => {
    const client = api([]);
    let resolveUpload: (value: typeof metadata) => void = () => undefined;
    client.upload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const persistentWrite = vi.spyOn(Storage.prototype, "setItem");
    render(<KnowledgePanel api={client} />);
    const file = new File(["private upload"], "architecture.txt", {
      type: "text/plain",
    });
    fireEvent.change(screen.getByLabelText("Choose file"), {
      target: { files: [file] },
    });
    const button = screen.getByRole("button", { name: "Upload file" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.submit(button.closest("form")!);
    expect(await screen.findByText("Selected: architecture.txt")).toBeVisible();
    await waitFor(() => expect(client.upload).toHaveBeenCalledWith(file));
    expect(screen.getByRole("button", { name: "Uploading…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Uploading…" }));
    expect(client.upload).toHaveBeenCalledTimes(1);
    resolveUpload({ ...metadata, sourceType: "file_txt" });
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    expect(persistentWrite).not.toHaveBeenCalled();
    persistentWrite.mockRestore();
  });
});
