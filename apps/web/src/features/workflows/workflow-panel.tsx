"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiFailure } from "../auth/authenticated-fetch";
import {
  WorkflowApi,
  type Workflow,
  type WorkflowStatus,
  type WorkflowSummary,
} from "./workflow-api";

export function WorkflowPanel({
  api,
}: Readonly<{
  api: Pick<WorkflowApi, "list" | "get" | "run" | "recover" | "cancel">;
}>) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selected, setSelected] = useState<Workflow>();
  const [loading, setLoading] = useState(true);
  const [viewingId, setViewingId] = useState<string>();
  const [runningId, setRunningId] = useState<string>();
  const [recoveringId, setRecoveringId] = useState<string>();
  const [confirmingCancelId, setConfirmingCancelId] = useState<string>();
  const [cancellingId, setCancellingId] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);

    try {
      setWorkflows(await api.list());
    } catch (reason) {
      setError(safeWorkflowError(reason));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    let active = true;

    void api.list().then(
      (rows) => {
        if (!active) return;
        setWorkflows(rows);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!active) return;
        setError(safeWorkflowError(reason));
        setLoading(false);
      },
    );

    return () => {
      active = false;
    };
  }, [api]);

  const view = async (workflowId: string) => {
    if (viewingId !== undefined) return;

    setViewingId(workflowId);
    setError(undefined);

    try {
      setSelected(await api.get(workflowId));
    } catch (reason) {
      setError(safeWorkflowError(reason));
    } finally {
      setViewingId(undefined);
    }
  };

  const run = async (workflowId: string) => {
    if (runningId !== undefined) return;

    setRunningId(workflowId);
    setError(undefined);

    try {
      const workflow = await api.run(workflowId);
      setSelected(workflow);
      await load();
    } catch (reason) {
      setError(safeWorkflowError(reason));
    } finally {
      setRunningId(undefined);
    }
  };

  const recover = async (workflowId: string) => {
    if (recoveringId !== undefined) return;

    setRecoveringId(workflowId);
    setError(undefined);

    try {
      const workflow = await api.recover(workflowId);
      setSelected(workflow);
      await load();
    } catch (reason) {
      setError(safeWorkflowError(reason));
    } finally {
      setRecoveringId(undefined);
    }
  };

  const cancel = async (workflowId: string) => {
    if (cancellingId !== undefined) return;

    setCancellingId(workflowId);
    setError(undefined);

    try {
      const workflow = await api.cancel(workflowId);
      setSelected((current) =>
        current?.id === workflowId ? workflow : current,
      );
      setConfirmingCancelId(undefined);
      await load();
    } catch (reason) {
      setError(safeWorkflowError(reason));
    } finally {
      setCancellingId(undefined);
    }
  };

  return (
    <section className="data-panel" aria-labelledby="workflow-heading">
      <header className="data-panel-heading">
        <div>
          <p className="eyebrow">Durable bounded automation</p>
          <h2 id="workflow-heading">Workflows</h2>
        </div>

        <button type="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </header>

      <p className="privacy-note">
        Workflow execution remains Gateway-controlled. This browser can inspect,
        explicitly run, explicitly recover, or explicitly cancel workflows. It
        cannot supply actor identity, permissions, runtime state, retries,
        approvals, leases, credentials, or execution results.
      </p>

      {error !== undefined && (
        <p role="alert" className="data-error">
          {error}
        </p>
      )}

      {selected !== undefined && (
        <article
          className="document-view workflow-detail"
          aria-label="Selected workflow"
        >
          <header>
            <div>
              <p className="eyebrow">Workflow detail</p>
              <h3>{selected.goal}</h3>
            </div>

            <button type="button" onClick={() => setSelected(undefined)}>
              Close
            </button>
          </header>

          <dl className="workflow-metadata">
            <div>
              <dt>Status</dt>
              <dd>{humanStatus(selected.status)}</dd>
            </div>

            <div>
              <dt>Created</dt>
              <dd>
                <time dateTime={selected.createdAt}>
                  {new Date(selected.createdAt).toLocaleString()}
                </time>
              </dd>
            </div>

            {selected.startedAt !== null && (
              <div>
                <dt>Started</dt>
                <dd>
                  <time dateTime={selected.startedAt}>
                    {new Date(selected.startedAt).toLocaleString()}
                  </time>
                </dd>
              </div>
            )}

            {selected.completedAt !== null && (
              <div>
                <dt>Completed</dt>
                <dd>
                  <time dateTime={selected.completedAt}>
                    {new Date(selected.completedAt).toLocaleString()}
                  </time>
                </dd>
              </div>
            )}
          </dl>

          <ol className="workflow-steps">
            {selected.steps.map((step) => (
              <li key={step.stepKey}>
                <div className="workflow-step-heading">
                  <strong>
                    {step.ordinal + 1}. {step.stepKey}
                  </strong>
                  <span>{humanStatus(step.status)}</span>
                </div>

                <p>{humanKind(step.kind)}</p>

                {step.dependsOn.length > 0 && (
                  <p>Depends on: {step.dependsOn.join(", ")}</p>
                )}

                {step.errorCode !== null && (
                  <p className="data-error">
                    Step error: {safeErrorCode(step.errorCode)}
                  </p>
                )}

                {step.hasResult && (
                  <p className="privacy-note">
                    Result exists but is intentionally not exposed here.
                  </p>
                )}
              </li>
            ))}
          </ol>

          <div className="document-actions">
            {canRun(selected.status) && (
              <button
                type="button"
                disabled={runningId !== undefined}
                onClick={() => void run(selected.id)}
              >
                {runningId === selected.id ? "Running…" : "Run workflow"}
              </button>
            )}

            {canRecover(selected.status) && (
              <button
                type="button"
                disabled={recoveringId !== undefined}
                onClick={() => void recover(selected.id)}
              >
                {recoveringId === selected.id
                  ? "Recovering…"
                  : "Recover workflow"}
              </button>
            )}

            {canCancel(selected.status) &&
              (confirmingCancelId === selected.id ? (
                <div
                  className="confirm-actions"
                  role="group"
                  aria-label="Confirm workflow cancellation"
                >
                  <span>Cancel this workflow?</span>

                  <button
                    type="button"
                    className="danger-button"
                    disabled={cancellingId !== undefined}
                    onClick={() => void cancel(selected.id)}
                  >
                    {cancellingId === selected.id
                      ? "Cancelling…"
                      : "Confirm cancel"}
                  </button>

                  <button
                    type="button"
                    onClick={() => setConfirmingCancelId(undefined)}
                  >
                    Keep workflow
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingCancelId(selected.id)}
                >
                  Cancel workflow
                </button>
              ))}
          </div>
        </article>
      )}

      {loading ? (
        <p role="status">Loading workflows…</p>
      ) : workflows.length === 0 ? (
        <p className="data-empty">No workflows found.</p>
      ) : (
        <ul className="data-list workflow-list">
          {workflows.map((workflow) => (
            <li key={workflow.id}>
              <div>
                <strong>{workflow.goal}</strong>

                <p>{humanStatus(workflow.status)}</p>

                <time dateTime={workflow.createdAt}>
                  Created {new Date(workflow.createdAt).toLocaleString()}
                </time>
              </div>

              <div className="document-actions">
                <button
                  type="button"
                  disabled={viewingId !== undefined}
                  onClick={() => void view(workflow.id)}
                >
                  {viewingId === workflow.id ? "Loading…" : "View"}
                </button>

                {canRun(workflow.status) && (
                  <button
                    type="button"
                    disabled={runningId !== undefined}
                    onClick={() => void run(workflow.id)}
                  >
                    {runningId === workflow.id ? "Running…" : "Run"}
                  </button>
                )}

                {canRecover(workflow.status) && (
                  <button
                    type="button"
                    disabled={recoveringId !== undefined}
                    onClick={() => void recover(workflow.id)}
                  >
                    {recoveringId === workflow.id ? "Recovering…" : "Recover"}
                  </button>
                )}

                {canCancel(workflow.status) &&
                  (confirmingCancelId === workflow.id ? (
                    <div
                      className="confirm-actions"
                      role="group"
                      aria-label="Confirm workflow cancellation"
                    >
                      <span>Cancel this workflow?</span>

                      <button
                        type="button"
                        className="danger-button"
                        disabled={cancellingId !== undefined}
                        onClick={() => void cancel(workflow.id)}
                      >
                        {cancellingId === workflow.id
                          ? "Cancelling…"
                          : "Confirm cancel"}
                      </button>

                      <button
                        type="button"
                        onClick={() => setConfirmingCancelId(undefined)}
                      >
                        Keep
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingCancelId(workflow.id)}
                    >
                      Cancel
                    </button>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function canRun(status: WorkflowStatus): boolean {
  return status === "READY";
}

function canRecover(status: WorkflowStatus): boolean {
  return status === "RUNNING";
}

function canCancel(status: WorkflowStatus): boolean {
  return status === "READY" || status === "AWAITING_APPROVAL";
}

function humanStatus(status: string): string {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function humanKind(kind: string): string {
  switch (kind) {
    case "tool":
      return "Tool action";
    case "memory_read":
      return "Memory read";
    case "memory_search":
      return "Memory search";
    case "knowledge_search":
      return "Knowledge search";
    default:
      return "Workflow step";
  }
}

function safeErrorCode(value: string): string {
  return /^[A-Z0-9_]{1,64}$/.test(value) ? value : "WORKFLOW_STEP_FAILED";
}

function safeWorkflowError(reason: unknown): string {
  if (reason instanceof ApiFailure && reason.status === 401)
    return "Your session expired. Sign in again to continue.";

  if (reason instanceof ApiFailure && reason.status === 403)
    return "You do not have permission to perform this workflow operation.";

  if (reason instanceof ApiFailure && reason.status === 404)
    return "That workflow is no longer available.";

  if (reason instanceof ApiFailure && reason.status === 409)
    return "The workflow is not currently in a state that allows this operation.";

  if (reason instanceof ApiFailure && reason.status === 400)
    return "The workflow request is invalid.";

  return "Workflow data could not be loaded or changed. Please try again.";
}
