import { describe, expect, it } from "vitest";
import { applyTransition, voiceReducer } from "./voice.slice";

describe("voice UI state", () => {
  it("tracks protocol state and in-memory transcript without duplicates", () => {
    let state = voiceReducer(
      undefined,
      applyTransition({ status: "listening", currentTurnId: "turn-1" }),
    );
    state = voiceReducer(
      state,
      applyTransition({
        status: "processing",
        currentTurnId: "turn-1",
        userText: "hello",
      }),
    );
    state = voiceReducer(
      state,
      applyTransition({
        status: "processing",
        currentTurnId: "turn-1",
        userText: "hello again",
        assistantText: "hi",
      }),
    );
    expect(state.status).toBe("processing");
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0]?.text).toBe("hello again");
  });
});
