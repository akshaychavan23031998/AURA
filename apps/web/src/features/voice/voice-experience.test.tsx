import { configureStore } from "@reduxjs/toolkit";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { describe, expect, it } from "vitest";
import { appReducer } from "@/store/slices/app.slice";
import { voiceReducer } from "@/store/slices/voice.slice";
import { VoiceExperience } from "./voice-experience";

describe("VoiceExperience", () => {
  it("renders accessible disconnected controls", () => {
    renderExperience();
    expect(
      screen.getByRole("button", { name: "Start voice session" }),
    ).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Offline");
  });
  it("shows a safe authentication error when no session exists", async () => {
    sessionStorage.clear();
    renderExperience();
    await userEvent.click(
      screen.getByRole("button", { name: "Start voice session" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/sign in/i);
  });
});

function renderExperience() {
  const store = configureStore({
    reducer: { app: appReducer, voice: voiceReducer },
  });
  return render(
    <Provider store={store}>
      <VoiceExperience />
    </Provider>,
  );
}
