import { z } from "zod";

export const VOICE_PROTOCOL = "aura.voice.v1" as const;
export const voiceStatusSchema = z.enum([
  "disconnected",
  "connecting",
  "ready",
  "listening",
  "processing",
  "speaking",
  "interrupting",
  "error",
]);
export type VoiceStatus = z.infer<typeof voiceStatusSchema>;

const baseEvent = z
  .object({
    protocol: z.literal(VOICE_PROTOCOL),
    type: z.string(),
    sessionId: z.string().uuid(),
    requestId: z.string().min(1).max(512),
    turnId: z.string().uuid().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const allowedTypes = new Set([
  "session.ready",
  "speech.started",
  "speech.ended",
  "transcript.final",
  "agent.started",
  "agent.completed",
  "tts.started",
  "audio.started",
  "audio.completed",
  "turn.completed",
  "turn.interrupting",
  "turn.interrupted",
  "turn.superseded",
  "turn.action_completed_after_interrupt",
  "error",
]);

export type VoiceServerEvent = z.infer<typeof baseEvent>;

export function parseVoiceEvent(input: unknown): VoiceServerEvent | undefined {
  const parsed = baseEvent.safeParse(input);
  return parsed.success && allowedTypes.has(parsed.data.type)
    ? parsed.data
    : undefined;
}

export interface VoiceUiTransition {
  status: VoiceStatus;
  currentTurnId?: string;
  userText?: string;
  assistantText?: string;
  error?: string;
}

export function transitionForEvent(event: VoiceServerEvent): VoiceUiTransition {
  const turn =
    event.turnId === undefined ? {} : { currentTurnId: event.turnId };
  switch (event.type) {
    case "session.ready":
      return { status: "ready" };
    case "speech.started":
      return { status: "listening", ...turn };
    case "speech.ended":
    case "agent.started":
      return { status: "processing", ...turn };
    case "transcript.final":
      return {
        status: "processing",
        ...turn,
        ...(typeof event.payload?.text === "string"
          ? { userText: event.payload.text }
          : {}),
      };
    case "agent.completed":
      return {
        status: "processing",
        ...turn,
        ...(typeof event.payload?.text === "string"
          ? { assistantText: event.payload.text }
          : {}),
      };
    case "tts.started":
      return { status: "processing", ...turn };
    case "audio.started":
      return { status: "speaking", ...turn };
    case "turn.interrupting":
    case "turn.interrupted":
      return { status: "interrupting", ...turn };
    case "turn.superseded":
      return { status: "listening" };
    case "audio.completed":
      return { status: "speaking", ...turn };
    case "turn.completed":
      return { status: "ready" };
    case "error":
      return {
        status: "error",
        ...turn,
        error: safeErrorMessage(event.payload?.code),
      };
    default:
      return { status: "processing", ...turn };
  }
}

function safeErrorMessage(code: unknown): string {
  if (code === "UNAUTHENTICATED") return "Your session expired. Sign in again.";
  if (code === "VOICE_SESSION_TIMEOUT") return "The voice session timed out.";
  if (code === "VOICE_BUFFER_LIMIT_EXCEEDED")
    return "That utterance was too long.";
  return "The voice session could not continue.";
}
