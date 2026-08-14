import { configureStore } from "@reduxjs/toolkit";
import { render, screen, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appReducer } from "@/store/slices/app.slice";
import { authReducer } from "@/store/slices/auth.slice";
import { voiceReducer } from "@/store/slices/voice.slice";
import { accessTokenStore } from "./access-token";
import { AuthExperience, isDevelopmentSessionEnabled } from "./auth-experience";

describe("AuthExperience", () => {
  beforeEach(() => accessTokenStore.clear());

  it("does not flash the authenticated application before bootstrap resolves", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(new Promise(() => undefined)),
    );
    renderExperience();
    expect(screen.getByRole("status")).toHaveTextContent(/checking/i);
    expect(
      screen.queryByRole("button", { name: "Start voice session" }),
    ).not.toBeInTheDocument();
  });

  it("renders the authenticated voice application after valid bootstrap", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()));
    renderExperience();
    expect(
      await screen.findByRole("button", { name: "Start voice session" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Log out of AURA" }),
    ).toBeEnabled();
  });

  it("renders unauthenticated UX when no session exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
    renderExperience();
    await waitFor(() =>
      expect(
        screen.getByText(/no authenticated browser session/i),
      ).toBeVisible(),
    );
    expect(
      screen.queryByRole("button", { name: /local development session/i }),
    ).not.toBeInTheDocument();
  });

  it("enables local bootstrap only with both development gates", () => {
    expect(
      isDevelopmentSessionEnabled({
        NODE_ENV: "development",
        NEXT_PUBLIC_ENABLE_DEV_SESSION: "true",
      }),
    ).toBe(true);
    expect(
      isDevelopmentSessionEnabled({
        NODE_ENV: "production",
        NEXT_PUBLIC_ENABLE_DEV_SESSION: "true",
      }),
    ).toBe(false);
    expect(isDevelopmentSessionEnabled({ NODE_ENV: "development" })).toBe(
      false,
    );
  });
});

function renderExperience() {
  const store = configureStore({
    reducer: { app: appReducer, auth: authReducer, voice: voiceReducer },
  });
  return render(
    <Provider store={store}>
      <AuthExperience />
    </Provider>,
  );
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({ accessToken: "one.two.three" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
