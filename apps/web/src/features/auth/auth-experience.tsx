"use client";

import { useCallback, useEffect, useMemo } from "react";
import { VoiceExperience } from "../voice/voice-experience";
import { accessTokenStore } from "./access-token";
import { AuthApi, AuthFailure } from "./auth-api";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { setAuthError, setAuthStatus } from "@/store/slices/auth.slice";
import { resetVoiceSession } from "@/store/slices/voice.slice";

export function AuthExperience() {
  const dispatch = useAppDispatch();
  const auth = useAppSelector((state) => state.auth);
  const api = useMemo(() => new AuthApi(accessTokenStore), []);

  const expireSession = useCallback(() => {
    accessTokenStore.clear();
    dispatch(resetVoiceSession());
    dispatch(setAuthStatus("session-expired"));
  }, [dispatch]);

  useEffect(() => {
    let active = true;
    void api.refresh().then(
      () => active && dispatch(setAuthStatus("authenticated")),
      (error: unknown) => {
        if (!active) return;
        dispatch(
          setAuthStatus(
            error instanceof AuthFailure && error.code === "unauthenticated"
              ? "unauthenticated"
              : "error",
          ),
        );
      },
    );
    return () => {
      active = false;
    };
  }, [api, dispatch]);

  const createDevelopmentSession = async () => {
    dispatch(setAuthStatus("authenticating"));
    try {
      await api.createDevelopmentSession();
      dispatch(setAuthStatus("authenticated"));
    } catch {
      dispatch(setAuthError("Development session could not be created."));
    }
  };

  const logout = async () => {
    dispatch(setAuthStatus("logging-out"));
    dispatch(resetVoiceSession());
    try {
      await api.logout();
    } finally {
      dispatch(setAuthStatus("unauthenticated"));
    }
  };

  if (auth.status === "authenticated") {
    const token = accessTokenStore.get();
    if (token === undefined) return <AuthPanel status="session-expired" />;
    return (
      <div className="authenticated-shell">
        <button
          className="logout-button"
          type="button"
          onClick={() => void logout()}
          aria-label="Log out of AURA"
        >
          Log out
        </button>
        <VoiceExperience
          getAccessToken={() => accessTokenStore.get()}
          onSessionExpired={expireSession}
        />
      </div>
    );
  }

  return (
    <AuthPanel
      status={auth.status}
      error={auth.error}
      onDevelopmentSession={
        isDevelopmentSessionEnabled()
          ? () => void createDevelopmentSession()
          : undefined
      }
    />
  );
}

export function isDevelopmentSessionEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    environment.NODE_ENV === "development" &&
    environment.NEXT_PUBLIC_ENABLE_DEV_SESSION === "true"
  );
}

function AuthPanel({
  status,
  error,
  onDevelopmentSession,
}: Readonly<{
  status: string;
  error?: string;
  onDevelopmentSession?: () => void;
}>) {
  const waiting = [
    "bootstrapping",
    "authenticating",
    "refreshing",
    "logging-out",
  ].includes(status);
  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-busy={waiting}>
        <div className="brand-mark" aria-hidden="true">
          A
        </div>
        <p className="eyebrow">Secure voice session</p>
        <h1>
          {waiting
            ? "Restoring your session"
            : status === "session-expired"
              ? "Session expired"
              : "Welcome to AURA"}
        </h1>
        <p className="auth-copy" role="status">
          {waiting
            ? "Checking your persisted browser session…"
            : status === "session-expired"
              ? "Your session is no longer valid. Authenticate again to continue."
              : (error ?? "No authenticated browser session is available.")}
        </p>
        {onDevelopmentSession !== undefined && !waiting && (
          <button
            className="voice-button"
            type="button"
            onClick={onDevelopmentSession}
          >
            Start local development session
          </button>
        )}
        {onDevelopmentSession !== undefined && (
          <p className="development-label">
            Development only · server-controlled identity
          </p>
        )}
      </section>
    </main>
  );
}
