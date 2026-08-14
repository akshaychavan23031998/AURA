export type TurnExecutionPhase =
  | "STT"
  | "AGENT_INITIAL"
  | "TOOL_EXECUTION"
  | "AGENT_FINALIZATION"
  | "TTS"
  | "AUDIO_DELIVERY"
  | "COMPLETED";

export type TurnCancellationState =
  "ACTIVE" | "INTERRUPTING" | "SUPERSEDED" | "SETTLED";

export type CancellationReason = "BARGE_IN" | "DISCONNECT";

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
