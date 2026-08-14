import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { VoiceStatus, VoiceUiTransition } from "@/features/voice/protocol";

export interface ConversationEntry {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  text: string;
}
export interface VoiceState {
  status: VoiceStatus;
  microphoneActive: boolean;
  currentTurnId?: string;
  entries: ConversationEntry[];
  error?: string;
}
const initialState: VoiceState = {
  status: "disconnected",
  microphoneActive: false,
  entries: [],
};

const voiceSlice = createSlice({
  name: "voice",
  initialState,
  reducers: {
    applyTransition(state, action: PayloadAction<VoiceUiTransition>) {
      const transition = action.payload;
      state.status = transition.status;
      state.microphoneActive = ![
        "disconnected",
        "connecting",
        "error",
      ].includes(transition.status);
      if (transition.currentTurnId !== undefined)
        state.currentTurnId = transition.currentTurnId;
      if (transition.error !== undefined) state.error = transition.error;
      else if (transition.status !== "error") state.error = undefined;
      if (
        transition.userText !== undefined &&
        transition.currentTurnId !== undefined
      )
        appendEntry(
          state.entries,
          transition.currentTurnId,
          "user",
          transition.userText,
        );
      if (
        transition.assistantText !== undefined &&
        transition.currentTurnId !== undefined
      )
        appendEntry(
          state.entries,
          transition.currentTurnId,
          "assistant",
          transition.assistantText,
        );
    },
    resetVoiceSession: () => initialState,
  },
});

function appendEntry(
  entries: ConversationEntry[],
  turnId: string,
  role: ConversationEntry["role"],
  text: string,
): void {
  const id = `${turnId}:${role}`;
  const existing = entries.find((entry) => entry.id === id);
  if (existing === undefined) entries.push({ id, turnId, role, text });
  else existing.text = text;
}
export const { applyTransition, resetVoiceSession } = voiceSlice.actions;
export const voiceReducer = voiceSlice.reducer;
