import { z } from "zod";

export const VOICE_PROTOCOL = "aura.voice.v1" as const;
export type VoiceProtocolVersion = typeof VOICE_PROTOCOL;
export type VoiceSessionState =
  | "CONNECTED"
  | "READY"
  | "LISTENING"
  | "PROCESSING"
  | "SPEAKING"
  | "INTERRUPTING"
  | "CLOSED";
export type VoiceSessionId = string;
export type VoiceTurnId = string;

export const clientEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("session.start"),
      protocol: z.literal(VOICE_PROTOCOL),
      locale: z.string().max(35).optional(),
    })
    .strict(),
  z.object({ type: z.literal("session.close") }).strict(),
]);
export type VoiceClientEvent = z.infer<typeof clientEventSchema>;

export interface VoiceServerEvent {
  readonly protocol: VoiceProtocolVersion;
  readonly type: string;
  readonly sessionId: VoiceSessionId;
  readonly requestId: string;
  readonly turnId?: VoiceTurnId;
  readonly payload?: Readonly<Record<string, unknown>>;
}
