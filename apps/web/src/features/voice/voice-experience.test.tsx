import { configureStore } from "@reduxjs/toolkit";
import { render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it } from "vitest";
import { appReducer } from "@/store/slices/app.slice";
import { voiceReducer } from "@/store/slices/voice.slice";
import { authReducer } from "@/store/slices/auth.slice";
import { VoiceExperience } from "./voice-experience";

describe("VoiceExperience", () => {
  it("renders accessible disconnected controls", () => {
    renderExperience();
    expect(
      screen.getByRole("button", { name: "Start voice session" }),
    ).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Offline");
  });
});

function renderExperience() {
  const store = configureStore({
    reducer: { app: appReducer, voice: voiceReducer, auth: authReducer },
  });
  return render(
    <Provider store={store}>
      <VoiceExperience
        getAccessToken={() => "one.two.three"}
        onSessionExpired={() => undefined}
      />
    </Provider>,
  );
}
