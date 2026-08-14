import { performance } from "node:perf_hooks";
import type { TrustedToolContext } from "../clients/tools/tool-service-client.js";
import type { VoiceServiceClient } from "../clients/voice/voice-service-client.js";
import type { AgentToolOrchestrator } from "./agent-tool-orchestrator.js";
import type { TurnExecutionPhase } from "../voice/cancellation.js";
export interface VoiceTurnLogger {
  info(bindings: object, message: string): void;
}
export interface VoiceTurnObserver {
  onTranscript?(transcript: { text: string; detectedLanguage: string }): void;
  onAgentStarted?(): void;
  onAgentCompleted?(responseText: string): void;
  onSynthesisStarted?(): void;
  onPhaseChange?(phase: TurnExecutionPhase): void;
  onToolDispatched?(): void;
  onToolCompleted?(): void;
}
export class VoiceTurnService {
  public constructor(
    private readonly voice: VoiceServiceClient,
    private readonly agent: AgentToolOrchestrator,
    private readonly logger?: VoiceTurnLogger,
  ) {}
  public async run(
    input: {
      audio: Buffer;
      mimeType: string;
      conversationId?: string;
      locale?: string;
    },
    requestId: string,
    context: TrustedToolContext,
    observer?: VoiceTurnObserver,
    signal?: AbortSignal,
  ) {
    const startedAt = performance.now();
    const sttAt = performance.now();
    observer?.onPhaseChange?.("STT");
    const transcript =
      signal === undefined
        ? await this.voice.transcribe(
            input.audio,
            input.mimeType,
            requestId,
            input.locale,
          )
        : await this.voice.transcribe(
            input.audio,
            input.mimeType,
            requestId,
            input.locale,
            signal,
          );
    observer?.onTranscript?.(transcript);
    const sttDurationMs = performance.now() - sttAt;
    const agentAt = performance.now();
    observer?.onAgentStarted?.();
    const result = await this.agent.run(
      {
        message: transcript.text,
        ...(input.conversationId === undefined
          ? {}
          : { conversationId: input.conversationId }),
        locale: input.locale ?? transcript.detectedLanguage,
      },
      requestId,
      context,
      {
        ...(signal === undefined ? {} : { signal }),
        ...(observer?.onPhaseChange === undefined
          ? {}
          : {
              onPhaseChange: (phase: TurnExecutionPhase) =>
                observer.onPhaseChange?.(phase),
            }),
        ...(observer?.onToolDispatched === undefined
          ? {}
          : { onToolDispatched: () => observer.onToolDispatched?.() }),
        ...(observer?.onToolCompleted === undefined
          ? {}
          : { onToolCompleted: () => observer.onToolCompleted?.() }),
      },
    );
    observer?.onAgentCompleted?.(result.response.text);
    const agentDurationMs = performance.now() - agentAt;
    const ttsAt = performance.now();
    observer?.onSynthesisStarted?.();
    observer?.onPhaseChange?.("TTS");
    const audio =
      signal === undefined
        ? await this.voice.synthesize(
            result.response.text,
            input.locale ?? transcript.detectedLanguage,
            requestId,
          )
        : await this.voice.synthesize(
            result.response.text,
            input.locale ?? transcript.detectedLanguage,
            requestId,
            signal,
          );
    const ttsDurationMs = performance.now() - ttsAt;
    observer?.onPhaseChange?.("COMPLETED");
    this.logger?.info(
      {
        requestId,
        audioBytes: input.audio.length,
        detectedLanguage: transcript.detectedLanguage,
        sttDurationMs,
        agentDurationMs,
        ttsDurationMs,
        totalDurationMs: performance.now() - startedAt,
      },
      "Voice turn completed",
    );
    return {
      transcript: transcript.text,
      detectedLanguage: transcript.detectedLanguage,
      responseText: result.response.text,
      audioBase64: audio.toString("base64"),
      audioMimeType: "audio/wav" as const,
    };
  }
}
