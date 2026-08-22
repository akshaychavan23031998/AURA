import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkflowPanel } from "./workflow-panel";
import type { Workflow, WorkflowSummary } from "./workflow-api";

const workflowId = "00000000-0000-4000-8000-000000000100";

const summary: WorkflowSummary = {
  id: workflowId,
  goal: "Prepare for meeting",
  status: "READY",
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
  cancelledAt: null,
  startedAt: null,
  completedAt: null,
};

const workflow: Workflow = {
  ...summary,
  steps: [
    {
      stepKey: "calendar",
      kind: "tool",
      ordinal: 0,
      status: "READY",
      dependsOn: [],
      payload: {
        tool: {
          name: "calendar.events.list",
          input: {},
        },
      },
      startedAt: null,
      completedAt: null,
      errorCode: null,
      hasResult: false,
    },
    {
      stepKey: "knowledge",
      kind: "knowledge_search",
      ordinal: 1,
      status: "BLOCKED",
      dependsOn: ["calendar"],
      payload: {
        query: "meeting notes",
      },
      startedAt: null,
      completedAt: null,
      errorCode: null,
      hasResult: false,
    },
  ],
};

function api(rows: WorkflowSummary[] = [summary]) {
  return {
    list: vi.fn().mockResolvedValue(rows),
    get: vi.fn().mockResolvedValue(workflow),
    run: vi.fn().mockResolvedValue({
      ...workflow,
      status: "RUNNING" as const,
      startedAt: "2026-08-21T00:05:00.000Z",
      steps: [
        {
          ...workflow.steps[0],
          status: "RUNNING" as const,
          startedAt: "2026-08-21T00:05:00.000Z",
        },
        workflow.steps[1],
      ],
    }),
    recover: vi.fn().mockResolvedValue({
      ...workflow,
      status: "RUNNING" as const,
      startedAt: "2026-08-21T00:05:00.000Z",
    }),
    cancel: vi.fn().mockResolvedValue({
      ...workflow,
      status: "CANCELLED" as const,
      cancelledAt: "2026-08-21T00:10:00.000Z",
      steps: workflow.steps.map((step) => ({
        ...step,
        status: "CANCELLED" as const,
      })),
    }),
  };
}

describe("WorkflowPanel", () => {
  it("lists workflows and opens trusted workflow detail", async () => {
    const client = api();

    render(<WorkflowPanel api={client} />);

    expect(await screen.findByText("Prepare for meeting")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "View" }));

    await waitFor(() => {
      expect(client.get).toHaveBeenCalledWith(workflowId);
    });

    expect(
      await screen.findByRole("article", {
        name: "Selected workflow",
      }),
    ).toBeVisible();

    expect(screen.getByText(/^1\.\s*calendar$/)).toBeVisible();
    expect(screen.getByText(/^2\.\s*knowledge$/)).toBeVisible();
    expect(screen.getByText(/Depends on:\s*calendar/)).toBeVisible();
  });

  it("runs a READY workflow only through an explicit action", async () => {
    const client = api();

    render(<WorkflowPanel api={client} />);

    const runButton = await screen.findByRole("button", {
      name: "Run",
    });

    expect(client.run).not.toHaveBeenCalled();

    fireEvent.click(runButton);

    await waitFor(() => {
      expect(client.run).toHaveBeenCalledWith(workflowId);
    });

    expect(client.run).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(client.list).toHaveBeenCalledTimes(2);
    });
  });

  it("requires explicit confirmation before cancelling", async () => {
    const client = api();

    render(<WorkflowPanel api={client} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Cancel",
      }),
    );

    expect(client.cancel).not.toHaveBeenCalled();

    expect(screen.getByText("Cancel this workflow?")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm cancel",
      }),
    );

    await waitFor(() => {
      expect(client.cancel).toHaveBeenCalledWith(workflowId);
    });

    expect(client.cancel).toHaveBeenCalledTimes(1);
  });

  it("offers recovery only for a RUNNING workflow", async () => {
    const runningSummary: WorkflowSummary = {
      ...summary,
      status: "RUNNING",
      startedAt: "2026-08-21T00:05:00.000Z",
    };

    const client = api([runningSummary]);

    client.get.mockResolvedValueOnce({
      ...workflow,
      ...runningSummary,
    });

    render(<WorkflowPanel api={client} />);

    expect(
      await screen.findByRole("button", {
        name: "Recover",
      }),
    ).toBeVisible();

    expect(
      screen.queryByRole("button", {
        name: "Run",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Recover",
      }),
    );

    await waitFor(() => {
      expect(client.recover).toHaveBeenCalledWith(workflowId);
    });
  });

  it("does not expose raw workflow results in the browser", async () => {
    const client = api();

    client.get.mockResolvedValueOnce({
      ...workflow,
      steps: [
        {
          ...workflow.steps[0],
          status: "SUCCEEDED",
          hasResult: true,
          completedAt: "2026-08-21T00:06:00.000Z",
        },
        workflow.steps[1],
      ],
    });

    render(<WorkflowPanel api={client} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "View",
      }),
    );

    expect(
      await screen.findByText(
        "Result exists but is intentionally not exposed here.",
      ),
    ).toBeVisible();

    expect(document.body.textContent).not.toMatch(
      /providerToken|accessToken|refreshToken|authorization/i,
    );
  });

  it("keeps workflow data ephemeral and avoids browser persistence", async () => {
    const client = api();
    const persistentWrite = vi.spyOn(Storage.prototype, "setItem");

    render(<WorkflowPanel api={client} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "View",
      }),
    );

    await screen.findByRole("article", {
      name: "Selected workflow",
    });

    expect(persistentWrite).not.toHaveBeenCalled();

    persistentWrite.mockRestore();
  });

  it("renders sanitized step error codes without exposing arbitrary text", async () => {
    const client = api();

    client.get.mockResolvedValueOnce({
      ...workflow,
      status: "FAILED",
      completedAt: "2026-08-21T00:07:00.000Z",
      steps: [
        {
          ...workflow.steps[0],
          status: "FAILED",
          errorCode: "TOOL_EXECUTION_FAILED",
          completedAt: "2026-08-21T00:07:00.000Z",
        },
        {
          ...workflow.steps[1],
          status: "SKIPPED",
          completedAt: "2026-08-21T00:07:00.000Z",
        },
      ],
    });

    render(<WorkflowPanel api={client} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "View",
      }),
    );

    expect(
      await screen.findByText("Step error: TOOL_EXECUTION_FAILED"),
    ).toBeVisible();
  });
});
