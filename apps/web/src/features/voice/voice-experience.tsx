"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveVoiceWebSocketUrl } from "./gateway-url";
import {
  VoiceSessionClient,
  type VoiceSessionCallbacks,
} from "./voice-session-client";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { applyTransition } from "@/store/slices/voice.slice";
import { ApprovalCard, type ApprovalView } from "../approvals/approval-card";
import { ApprovalApi } from "../approvals/approval-api";
import { AuthApi } from "../auth/auth-api";
import { AuthenticatedFetch, ApiFailure } from "../auth/authenticated-fetch";
import { accessTokenStore } from "../auth/access-token";
import { resolveGatewayHttpUrl } from "./gateway-url";

const labels = {
  disconnected: "Offline",
  connecting: "Connecting",
  ready: "Ready",
  listening: "Listening",
  processing: "Thinking",
  speaking: "Speaking",
  interrupting: "Interrupting",
  "awaiting-approval": "Approval needed",
  error: "Needs attention",
} as const;

export function VoiceExperience({
  getAccessToken,
  onSessionExpired,
  createSessionClient = (url, token, callbacks) =>
    new VoiceSessionClient(url, token, callbacks),
}: Readonly<{
  getAccessToken(): string | undefined;
  onSessionExpired(): void;
  createSessionClient?(
    url: string,
    token: string,
    callbacks: VoiceSessionCallbacks,
  ): VoiceSessionClient;
}>) {
  const dispatch = useAppDispatch();
  const voice = useAppSelector((state) => state.voice);
  const clientRef = useRef<VoiceSessionClient | undefined>(undefined);
  const [approval, setApproval] = useState<ApprovalView>();
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState<string>();
  const approvalApi = useMemo(() => {
    const auth = new AuthApi(accessTokenStore);
    return new ApprovalApi(
      new AuthenticatedFetch(accessTokenStore, auth),
      resolveGatewayHttpUrl(),
    );
  }, []);

  const disconnect = useCallback(async () => {
    const client = clientRef.current;
    clientRef.current = undefined;
    await client?.disconnect();
  }, []);

  useEffect(
    () => () => {
      void disconnect();
    },
    [disconnect],
  );

  const connect = async () => {
    if (clientRef.current !== undefined) return;
    try {
      const accessToken = getAccessToken();
      if (accessToken === undefined) {
        onSessionExpired();
        return;
      }
      const client = createSessionClient(
        resolveVoiceWebSocketUrl(),
        accessToken,
        {
          onTransition: (transition) => dispatch(applyTransition(transition)),
          onEvent: (event) => {
            if (event.type !== "approval.required") return;
            const payload = event.payload;
            if (
              typeof payload?.approvalId !== "string" ||
              typeof payload.title !== "string" ||
              typeof payload.preview !== "string" ||
              typeof payload.expiresAt !== "string"
            )
              return;
            setApproval({
              approvalId: payload.approvalId,
              title: payload.title,
              preview: payload.preview,
              status: "PENDING",
              expiresAt: payload.expiresAt,
            });
            setApprovalError(undefined);
          },
          onSessionExpired,
        },
      );
      clientRef.current = client;
      await client.connect(navigator.language);
    } catch {
      clientRef.current = undefined;
      dispatch(
        applyTransition({
          status: "error",
          error: "Voice configuration is unavailable.",
        }),
      );
    }
  };

  const connected = !["disconnected", "error"].includes(voice.status);
  const busy = voice.status === "connecting";
  const decideApproval = async (decision: "approve" | "reject", id: string) => {
    setApprovalBusy(true);
    setApprovalError(undefined);
    try {
      const response = await approvalApi[decision](id);
      setApproval((current) =>
        current?.approvalId === id
          ? { ...current, status: response.approval.status }
          : current,
      );
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401)
        onSessionExpired();
      else setApprovalError("The approval decision could not be completed.");
    } finally {
      setApprovalBusy(false);
    }
  };
  return (
    <main className="voice-shell">
      <header className="brand-bar">
        <div className="brand-mark" aria-hidden="true">
          A
        </div>
        <div>
          <p className="eyebrow">Self-hosted voice intelligence</p>
          <h1>AURA</h1>
        </div>
        <div
          className={`connection-pill status-${voice.status}`}
          role="status"
          aria-live="polite"
        >
          <span className="status-dot" aria-hidden="true" />
          {labels[voice.status]}
        </div>
      </header>

      <section
        className="conversation-panel"
        aria-labelledby="conversation-heading"
      >
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Live session</p>
            <h2 id="conversation-heading">Conversation</h2>
          </div>
          <span className="privacy-note">Audio stays ephemeral</span>
        </div>
        <div
          className="conversation"
          aria-live="polite"
          aria-relevant="additions text"
        >
          {voice.entries.length === 0 ? (
            <div className="empty-state">
              <div className={`orb orb-${voice.status}`} aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <h3>{stateHeadline(voice.status)}</h3>
              <p>{stateGuidance(voice.status)}</p>
            </div>
          ) : (
            voice.entries.map((entry) => (
              <article
                className={`message message-${entry.role}`}
                key={entry.id}
              >
                <p className="message-role">
                  {entry.role === "user" ? "You" : "AURA"}
                </p>
                <p>{entry.text}</p>
              </article>
            ))
          )}
        </div>
        {voice.error !== undefined && (
          <div className="error-banner" role="alert">
            <strong>Voice session unavailable</strong>
            <span>{voice.error}</span>
          </div>
        )}
        {approval !== undefined && (
          <ApprovalCard
            approval={approval}
            busy={approvalBusy}
            error={approvalError}
            onApprove={(id) => decideApproval("approve", id)}
            onReject={(id) => decideApproval("reject", id)}
          />
        )}
      </section>

      <footer className="control-dock">
        <div className="mic-copy">
          <span
            className={`mic-indicator ${voice.microphoneActive ? "mic-live" : ""}`}
            aria-hidden="true"
          />
          <div>
            <strong>
              {voice.microphoneActive ? "Microphone active" : "Microphone off"}
            </strong>
            <span>
              {voice.status === "speaking"
                ? "Speak naturally to interrupt"
                : "Live 20 ms voice frames"}
            </span>
          </div>
        </div>
        <button
          className={`voice-button ${connected ? "voice-button-stop" : ""}`}
          type="button"
          onClick={() => void (connected ? disconnect() : connect())}
          disabled={busy}
          aria-label={connected ? "Stop voice session" : "Start voice session"}
        >
          <span className="button-icon" aria-hidden="true">
            {connected ? "■" : "●"}
          </span>
          {busy ? "Connecting…" : connected ? "End session" : "Start voice"}
        </button>
        <p className="keyboard-hint">
          Use Tab to focus controls · Enter to activate
        </p>
      </footer>
    </main>
  );
}

function stateHeadline(status: keyof typeof labels): string {
  return {
    disconnected: "Ready when you are",
    connecting: "Opening a secure session",
    ready: "Say something",
    listening: "I’m listening",
    processing: "Working on it",
    speaking: "AURA is speaking",
    interrupting: "Switching turns",
    "awaiting-approval": "Your confirmation is required",
    error: "Let’s fix the connection",
  }[status];
}
function stateGuidance(status: keyof typeof labels): string {
  if (status === "disconnected")
    return "Start a voice session to begin a private, in-memory conversation.";
  if (status === "speaking")
    return "You can speak at any time. The server will safely decide when to interrupt.";
  if (status === "listening")
    return "Speak naturally. Silence marks the end of your turn.";
  if (status === "awaiting-approval")
    return "Review the exact action below. Speech cannot approve it.";
  if (status === "error")
    return "Review the message below, then reconnect manually.";
  return "Session state follows the authenticated Gateway in real time.";
}
