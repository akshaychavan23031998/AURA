import { performance } from "node:perf_hooks";
import type { TrustedToolContext } from "../clients/tools/tool-service-client.js";
import type { VoiceServiceClient } from "../clients/voice/voice-service-client.js";
import type { AgentToolOrchestrator } from "./agent-tool-orchestrator.js";
export interface VoiceTurnLogger {
  info(bindings: object, message: string): void;
}
export interface VoiceTurnObserver {
  onTranscript?(transcript: { text: string; detectedLanguage: string }): void;
  onAgentStarted?(): void;
  onAgentCompleted?(responseText: string): void;
  onSynthesisStarted?(): void;
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
  ) {
    const startedAt = performance.now();
    const sttAt = performance.now();
    const transcript = await this.voice.transcribe(
      input.audio,
      input.mimeType,
      requestId,
      input.locale,
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
    );
    observer?.onAgentCompleted?.(result.response.text);
    const agentDurationMs = performance.now() - agentAt;
    const ttsAt = performance.now();
    observer?.onSynthesisStarted?.();
    const audio = await this.voice.synthesize(
      result.response.text,
      input.locale ?? transcript.detectedLanguage,
      requestId,
    );
    const ttsDurationMs = performance.now() - ttsAt;
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
