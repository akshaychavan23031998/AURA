"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CAPABILITY_LABELS,
  GoogleIntegrationApi,
  type GoogleIntegrationStatus,
} from "./google-integration";

export function GoogleIntegrationPanel({
  api,
}: Readonly<{
  api: Pick<GoogleIntegrationApi, "status" | "reconnect" | "disconnect">;
}>) {
  const [status, setStatus] = useState<GoogleIntegrationStatus>();
  const [operation, setOperation] = useState<
    "loading" | "reconnect" | "disconnect"
  >("loading");
  const [error, setError] = useState<string>();
  const returnResult =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("integration");

  const load = useCallback(async () => {
    setOperation("loading");
    try {
      setStatus(await api.status());
      setError(undefined);
    } catch {
      setError("Google connection status is temporarily unavailable.");
    } finally {
      setOperation("loading");
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    void api.status().then(
      (nextStatus) => {
        if (!active) return;
        setStatus(nextStatus);
        setError(undefined);
      },
      () => {
        if (active)
          setError("Google connection status is temporarily unavailable.");
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  const reconnect = async () => {
    setOperation("reconnect");
    setError(undefined);
    try {
      window.location.assign(await api.reconnect());
    } catch {
      setError("Google reconnect could not be started. Please try again.");
      setOperation("loading");
    }
  };

  const disconnect = async () => {
    setOperation("disconnect");
    setError(undefined);
    try {
      await api.disconnect();
      await load();
    } catch {
      setError("Google could not be disconnected. Please try again.");
      setOperation("loading");
    }
  };

  const waiting = operation !== "loading" || status === undefined;
  const needsAccess = status?.capabilities.some(
    (capability) => capability.status === "reauth_required",
  );
  return (
    <section
      className="integration-panel"
      aria-busy={waiting}
      aria-labelledby="google-account-title"
    >
      <div>
        <p className="eyebrow">Connected account</p>
        <h2 id="google-account-title">Google Account</h2>
        <p role="status">
          {status === undefined
            ? "Checking Google capabilities…"
            : status.linked
              ? "Connected"
              : "Not connected"}
        </p>
      </div>
      {returnResult === "success" && (
        <p className="integration-success">Google permissions updated.</p>
      )}
      {returnResult === "account_mismatch" && (
        <p className="integration-error" role="alert">
          Use the Google account already linked to this AURA account.
        </p>
      )}
      {(returnResult === "failed" || returnResult === "cancelled") && (
        <p className="integration-error" role="alert">
          Google permissions were not changed.
        </p>
      )}
      {status !== undefined && (
        <ul className="capability-list">
          {status.capabilities.map((capability) => (
            <li key={capability.id}>
              <span>{CAPABILITY_LABELS[capability.id]}</span>
              <strong>
                {capability.status === "granted"
                  ? "Connected"
                  : "Needs permission"}
              </strong>
            </li>
          ))}
        </ul>
      )}
      {error !== undefined && (
        <p className="integration-error" role="alert">
          {error}
        </p>
      )}
      <div className="integration-actions">
        {(needsAccess || status?.linked === false) && (
          <button
            type="button"
            disabled={waiting}
            onClick={() => void reconnect()}
          >
            Reconnect Google
          </button>
        )}
        {status?.linked && (
          <button
            type="button"
            disabled={waiting}
            onClick={() => void disconnect()}
          >
            Disconnect Google
          </button>
        )}
      </div>
    </section>
  );
}
