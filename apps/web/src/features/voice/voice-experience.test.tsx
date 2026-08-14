import { configureStore } from "@reduxjs/toolkit";
import { fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";
import { appReducer } from "@/store/slices/app.slice";
import { voiceReducer } from "@/store/slices/voice.slice";
import { authReducer } from "@/store/slices/auth.slice";
import { VoiceExperience } from "./voice-experience";
import type { VoiceSessionCallbacks } from "./voice-session-client";
import type { VoiceSessionClient } from "./voice-session-client";

describe("VoiceExperience", () => {
  it("renders accessible disconnected controls", () => {
    renderExperience();
    expect(
      screen.getByRole("button", { name: "Start voice session" }),
    ).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Offline");
  });

  it("renders approval UI only after an authoritative protocol event", async () => {
    let callbacks: VoiceSessionCallbacks | undefined;
    renderExperience((received) => {
      callbacks = received;
    });
    expect(screen.queryByRole("button", { name: "Approve action" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Start voice session" }),
    );
    callbacks?.onEvent?.({
      protocol: "aura.voice.v1",
      type: "approval.required",
      sessionId: "00000000-0000-4000-8000-000000000001",
      requestId: "request",
      turnId: "00000000-0000-4000-8000-000000000002",
      payload: {
        approvalId: "00000000-0000-4000-8000-000000000003",
        title: "Confirm action",
        preview: "Run the exact stored action",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    });
    expect(
      await screen.findByRole("button", { name: "Approve action" }),
    ).toBeEnabled();
    expect(screen.getByText("Run the exact stored action")).toBeVisible();
  });
});

function renderExperience(
  capture?: (callbacks: VoiceSessionCallbacks) => void,
) {
  const store = configureStore({
    reducer: { app: appReducer, voice: voiceReducer, auth: authReducer },
  });
  return render(
    <Provider store={store}>
      <VoiceExperience
        getAccessToken={() => "one.two.three"}
        onSessionExpired={() => undefined}
        createSessionClient={(_url, _token, callbacks) => {
          capture?.(callbacks);
          return {
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn().mockResolvedValue(undefined),
          } as unknown as VoiceSessionClient;
        }}
      />
    </Provider>,
  );
}
