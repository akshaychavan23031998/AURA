"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiFailure } from "../auth/authenticated-fetch";
import {
  KnowledgeApi,
  type KnowledgeDocument,
  type KnowledgeMetadata,
  type KnowledgeSearchResult,
} from "./knowledge-api";

export function KnowledgePanel({
  api,
}: Readonly<{
  api: Pick<
    KnowledgeApi,
    "list" | "get" | "create" | "upload" | "delete" | "search"
  >;
}>) {
  const [documents, setDocuments] = useState<KnowledgeMetadata[]>([]);
  const [selected, setSelected] = useState<KnowledgeDocument>();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeSearchResult[]>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [upload, setUpload] = useState<File>();
  const [uploading, setUploading] = useState(false);
  const [uploadInputKey, setUploadInputKey] = useState(0);
  const [searching, setSearching] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setDocuments(await api.list());
    } catch (reason) {
      setError(safeKnowledgeError(reason));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    void api.list().then(
      (rows) => {
        if (!active) return;
        setDocuments(rows);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!active) return;
        setError(safeKnowledgeError(reason));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  const ingest = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!validDocument(title, content) || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await api.create({ title: title.trim(), content });
      setTitle("");
      setContent("");
      await load();
    } catch (reason) {
      setError(safeKnowledgeError(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const view = async (documentId: string) => {
    setError(undefined);
    try {
      setSelected(await api.get(documentId));
    } catch (reason) {
      setError(safeKnowledgeError(reason));
    }
  };

  const uploadFile = async (event: React.FormEvent) => {
    event.preventDefault();
    if (upload === undefined || uploading || upload.size > 10 * 1024 * 1024)
      return;
    setUploading(true);
    setError(undefined);
    try {
      await api.upload(upload);
      setUpload(undefined);
      setUploadInputKey((value) => value + 1);
      await load();
    } catch (reason) {
      setError(safeKnowledgeError(reason));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (documentId: string) => {
    if (deletingId !== undefined) return;
    setDeletingId(documentId);
    setError(undefined);
    try {
      await api.delete(documentId);
      setSelected((current) =>
        current?.id === documentId ? undefined : current,
      );
      setConfirmingId(undefined);
      await load();
    } catch (reason) {
      setError(safeKnowledgeError(reason));
    } finally {
      setDeletingId(undefined);
    }
  };

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length === 0 || trimmed.length > 1024 || searching) return;
    setSearching(true);
    setError(undefined);
    try {
      setResults(await api.search(trimmed));
    } catch (reason) {
      setError(safeKnowledgeError(reason));
      setResults(undefined);
    } finally {
      setSearching(false);
    }
  };

  return (
    <section className="data-panel" aria-labelledby="knowledge-heading">
      <header className="data-panel-heading">
        <div>
          <p className="eyebrow">Explicit personal knowledge</p>
          <h2 id="knowledge-heading">Knowledge</h2>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </header>
      <p className="privacy-note">
        The server owns normalization, chunking, hashing, embeddings, and search
        policy. This browser sends only title/content, one selected file, or a
        deliberate query.
      </p>

      <div className="knowledge-grid">
        <form className="data-form" onSubmit={(event) => void ingest(event)}>
          <h3>Add a plaintext document</h3>
          <label htmlFor="knowledge-title">Title</label>
          <input
            id="knowledge-title"
            value={title}
            maxLength={200}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
          <label htmlFor="knowledge-content">Content</label>
          <textarea
            id="knowledge-content"
            className="document-input"
            value={content}
            maxLength={131_072}
            required
            onChange={(event) => setContent(event.target.value)}
          />
          <button
            type="submit"
            disabled={submitting || !validDocument(title, content)}
          >
            {submitting ? "Ingesting…" : "Add document"}
          </button>
        </form>

        <form
          className="data-form"
          onSubmit={(event) => void uploadFile(event)}
        >
          <h3>Upload a knowledge file</h3>
          <p>TXT, text-based PDF, or DOCX. Maximum 10 MiB.</p>
          <label htmlFor="knowledge-file">Choose file</label>
          <input
            key={uploadInputKey}
            id="knowledge-file"
            type="file"
            name="file"
            accept=".txt,.pdf,.docx"
            required
            onChange={(event) => setUpload(event.target.files?.[0])}
          />
          {upload !== undefined && (
            <p className="selected-file" role="status">
              Selected: {upload.name}
            </p>
          )}
          <button
            type="submit"
            disabled={
              uploading ||
              upload === undefined ||
              upload.size > 10 * 1024 * 1024
            }
          >
            {uploading ? "Uploading…" : "Upload file"}
          </button>
        </form>

        <form className="data-form" onSubmit={(event) => void search(event)}>
          <h3>Search saved knowledge</h3>
          <label htmlFor="knowledge-query">Search query</label>
          <input
            id="knowledge-query"
            value={query}
            maxLength={1024}
            required
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="submit"
            disabled={searching || query.trim().length === 0}
          >
            {searching ? "Searching…" : "Search"}
          </button>
          {results !== undefined &&
            (results.length === 0 ? (
              <p className="data-empty" role="status">
                No matching saved knowledge was found.
              </p>
            ) : (
              <ol className="search-results">
                {results.map((result) => (
                  <li key={result.chunkId}>
                    <strong>{result.title}</strong>
                    <p>{result.content}</p>
                  </li>
                ))}
              </ol>
            ))}
        </form>
      </div>

      {error !== undefined && (
        <p role="alert" className="data-error">
          {error}
        </p>
      )}
      {selected !== undefined && (
        <article
          className="document-view"
          aria-label="Selected knowledge document"
        >
          <header>
            <h3>{selected.title}</h3>
            <button type="button" onClick={() => setSelected(undefined)}>
              Close
            </button>
          </header>
          <pre>{selected.content}</pre>
        </article>
      )}
      {loading ? (
        <p role="status">Loading knowledge documents…</p>
      ) : documents.length === 0 ? (
        <p className="data-empty">No knowledge documents found.</p>
      ) : (
        <ul className="data-list">
          {documents.map((document) => (
            <li key={document.id}>
              <div>
                <strong>{document.title}</strong>
                <p>{document.chunkCount} bounded chunks</p>
                <time dateTime={document.createdAt}>
                  Added {new Date(document.createdAt).toLocaleString()}
                </time>
              </div>
              <div className="document-actions">
                <button type="button" onClick={() => void view(document.id)}>
                  View
                </button>
                {confirmingId === document.id ? (
                  <div
                    className="confirm-actions"
                    role="group"
                    aria-label="Confirm document deletion"
                  >
                    <span>Delete this document?</span>
                    <button
                      type="button"
                      className="danger-button"
                      disabled={deletingId !== undefined}
                      onClick={() => void remove(document.id)}
                    >
                      {deletingId === document.id
                        ? "Deleting…"
                        : "Confirm delete"}
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
                    onClick={() => setConfirmingId(document.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function validDocument(title: string, content: string): boolean {
  return (
    title.trim().length > 0 &&
    title.length <= 200 &&
    content.trim().length > 0 &&
    new TextEncoder().encode(content).length <= 131_072
  );
}

function safeKnowledgeError(reason: unknown): string {
  if (reason instanceof ApiFailure && reason.status === 403)
    return "You do not have permission to perform this knowledge operation.";
  if (reason instanceof ApiFailure && reason.status === 401)
    return "Your session expired. Sign in again to continue.";
  if (reason instanceof ApiFailure && reason.status === 400)
    return "The knowledge input or selected file is invalid, empty, or contains no supported text.";
  if (reason instanceof ApiFailure && reason.status === 413)
    return "The selected file exceeds the 10 MiB upload limit.";
  if (reason instanceof ApiFailure && reason.status === 415)
    return "Only UTF-8 TXT, text-based PDF, and DOCX files are supported.";
  if (reason instanceof ApiFailure && reason.status === 422)
    return "Text could not be safely extracted from the selected file.";
  if (reason instanceof ApiFailure && reason.status === 404)
    return "That knowledge document is no longer available.";
  if (reason instanceof ApiFailure && reason.status === 503)
    return "Semantic knowledge search is temporarily unavailable.";
  return "Knowledge data could not be loaded or changed. Please try again.";
}
