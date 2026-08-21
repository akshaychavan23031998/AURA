"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiFailure } from "../auth/authenticated-fetch";
import { type MemoryKind, type MemoryView, MemoryApi } from "./memory-api";

const KINDS: readonly MemoryKind[] = [
  "preference",
  "fact",
  "instruction",
  "note",
];

export function MemoryPanel({
  api,
}: Readonly<{
  api: Pick<MemoryApi, "list" | "create" | "delete">;
}>) {
  const [memories, setMemories] = useState<MemoryView[]>([]);
  const [kind, setKind] = useState<MemoryKind>("preference");
  const [filter, setFilter] = useState<MemoryKind | "all">("all");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string>();
  const [confirmingId, setConfirmingId] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setMemories(await api.list(filter === "all" ? undefined : filter));
    } catch (reason) {
      setError(safeMemoryError(reason));
    } finally {
      setLoading(false);
    }
  }, [api, filter]);

  useEffect(() => {
    let active = true;
    void api.list(filter === "all" ? undefined : filter).then(
      (rows) => {
        if (!active) return;
        setMemories(rows);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!active) return;
        setError(safeMemoryError(reason));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [api, filter]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = content.trim();
    if (trimmed.length === 0 || trimmed.length > 4096 || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await api.create({ kind, content: trimmed });
      setContent("");
      await load();
    } catch (reason) {
      setError(safeMemoryError(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (memoryId: string) => {
    if (deletingId !== undefined) return;
    setDeletingId(memoryId);
    setError(undefined);
    try {
      await api.delete(memoryId);
      setConfirmingId(undefined);
      await load();
    } catch (reason) {
      setError(safeMemoryError(reason));
    } finally {
      setDeletingId(undefined);
    }
  };

  return (
    <section className="data-panel" aria-labelledby="memory-heading">
      <header className="data-panel-heading">
        <div>
          <p className="eyebrow">Explicit user data</p>
          <h2 id="memory-heading">Memory</h2>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </header>
      <p className="privacy-note">
        AURA stores only memories you deliberately submit. Drafts stay in this
        page and are never auto-saved.
      </p>

      <form className="data-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="memory-kind">Kind</label>
        <select
          id="memory-kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as MemoryKind)}
        >
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <label htmlFor="memory-content">Content</label>
        <textarea
          id="memory-content"
          value={content}
          maxLength={4096}
          required
          onChange={(event) => setContent(event.target.value)}
          aria-describedby="memory-content-help"
        />
        <span id="memory-content-help" className="field-help">
          Maximum 4,096 characters. Nothing is saved until you submit.
        </span>
        <button
          type="submit"
          disabled={submitting || content.trim().length === 0}
        >
          {submitting ? "Saving…" : "Save memory"}
        </button>
      </form>

      <div className="data-toolbar">
        <label htmlFor="memory-filter">Filter</label>
        <select
          id="memory-filter"
          value={filter}
          onChange={(event) => {
            setLoading(true);
            setError(undefined);
            setFilter(event.target.value as MemoryKind | "all");
          }}
        >
          <option value="all">All kinds</option>
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      {error !== undefined && (
        <p role="alert" className="data-error">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading saved memories…</p>
      ) : memories.length === 0 ? (
        <p className="data-empty">No explicit saved memories found.</p>
      ) : (
        <ul className="data-list">
          {memories.map((memory) => (
            <li key={memory.id}>
              <div>
                <span className="data-kind">{memory.kind}</span>
                <p>{memory.content}</p>
                <time dateTime={memory.createdAt}>
                  Saved {new Date(memory.createdAt).toLocaleString()}
                </time>
              </div>
              {confirmingId === memory.id ? (
                <div
                  className="confirm-actions"
                  role="group"
                  aria-label="Confirm memory deletion"
                >
                  <span>Delete this memory?</span>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={deletingId !== undefined}
                    onClick={() => void remove(memory.id)}
                  >
                    {deletingId === memory.id ? "Deleting…" : "Confirm delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingId(undefined)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingId(memory.id)}
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function safeMemoryError(reason: unknown): string {
  if (reason instanceof ApiFailure && reason.status === 403)
    return "You do not have permission to perform this memory operation.";
  if (reason instanceof ApiFailure && reason.status === 401)
    return "Your session expired. Sign in again to continue.";
  if (reason instanceof ApiFailure && reason.status === 400)
    return "The memory input is invalid. Review the kind and content limits.";
  if (reason instanceof ApiFailure && reason.status === 404)
    return "That memory is no longer available.";
  return "Memory data could not be loaded or changed. Please try again.";
}
