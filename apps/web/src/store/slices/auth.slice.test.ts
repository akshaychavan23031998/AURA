import { describe, expect, it } from "vitest";
import { authReducer, setAuthError, setAuthStatus } from "./auth.slice";

describe("auth slice", () => {
  it("tracks safe lifecycle state without token material", () => {
    let state = authReducer(undefined, setAuthStatus("authenticated"));
    state = authReducer(state, setAuthError("Session unavailable"));
    expect(state).toEqual({ status: "error", error: "Session unavailable" });
    expect(JSON.stringify(state)).not.toMatch(/token|jwt|secret/i);
  });
});
