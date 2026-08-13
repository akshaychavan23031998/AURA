import { randomUUID } from "node:crypto";
import type { TrustedToolContext } from "../clients/tools/tool-service-client.js";
import type { VoiceTurnService } from "../orchestration/voice-turn-service.js";
import { pcmToWav } from "./pcm.js";
import { EnergyVad } from "./vad.js";
import {
  VOICE_PROTOCOL,
  type VoiceServerEvent,
  type VoiceSessionState,
} from "./protocol.js";

export interface SessionLimits {
  frameBytes: number;
  maxFrameBytes: number;
  maxBufferBytes: number;
  maxUtteranceMs: number;
  audioChunkBytes: number;
  vadThreshold: number;
  vadMinSpeechMs: number;
  vadEndSilenceMs: number;
  frameMs: number;
}
export interface SessionSink {
  event(event: VoiceServerEvent): void;
  audio(chunk: Buffer): void;
  close(): void;
}

export class VoiceSessionCoordinator {
  public state: VoiceSessionState = "CONNECTED";
  public readonly sessionId = randomUUID();
  private readonly vad: EnergyVad;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private frames = 0;
  private turnId: string | undefined;
  private closed = false;
  public constructor(
    private readonly rootRequestId: string,
    private readonly context: TrustedToolContext,
    private readonly turns: VoiceTurnService,
    private readonly sink: SessionSink,
    private readonly limits: SessionLimits,
    private locale?: string,
  ) {
    this.vad = new EnergyVad({
      frameBytes: limits.frameBytes,
      threshold: limits.vadThreshold,
      minSpeechMs: limits.vadMinSpeechMs,
      endSilenceMs: limits.vadEndSilenceMs,
      frameMs: limits.frameMs,
    });
  }
  public start(locale?: string): void {
    if (this.state !== "CONNECTED") return this.error("VOICE_INVALID_EVENT");
    this.locale = locale;
    this.state = "READY";
    this.emit("session.ready", undefined, {
      input: {
        sampleRate: 16000,
        channels: 1,
        sampleWidth: 2,
        frameMs: this.limits.frameMs,
      },
    });
  }
  public acceptAudio(frame: Buffer): void {
    if (this.closed) return;
    if (this.state === "PROCESSING" || this.state === "SPEAKING")
      return this.error("VOICE_BUSY", this.turnId);
    if (this.state !== "READY" && this.state !== "LISTENING")
      return this.error("VOICE_INVALID_FRAME");
    if (
      frame.length > this.limits.maxFrameBytes ||
      frame.length !== this.limits.frameBytes
    )
      return this.error("VOICE_INVALID_FRAME");
    if (this.bytes + frame.length > this.limits.maxBufferBytes)
      return this.error("VOICE_BUFFER_LIMIT_EXCEEDED");
    const decision = this.vad.accept(frame);
    if (decision === "speech.started") {
      this.turnId = randomUUID();
      this.state = "LISTENING";
      this.emit("speech.started", this.turnId);
    }
    if (this.state === "LISTENING") {
      this.chunks.push(Buffer.from(frame));
      this.bytes += frame.length;
      this.frames += 1;
      if (this.frames * this.limits.frameMs > this.limits.maxUtteranceMs)
        return this.failTurn("VOICE_TURN_TOO_LONG");
    }
    if (decision === "speech.ended" && this.turnId !== undefined) {
      const turnId = this.turnId;
      this.emit("speech.ended", turnId);
      void this.process(turnId);
    }
  }
  public close(): void {
    this.closed = true;
    this.state = "CLOSED";
    this.chunks = [];
    this.bytes = 0;
    this.vad.reset();
  }
  private async process(turnId: string): Promise<void> {
    this.state = "PROCESSING";
    const requestId = `${this.rootRequestId}:${turnId}`;
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    this.bytes = 0;
    this.frames = 0;
    let failureCode = "VOICE_STT_FAILED";
    try {
      const result = await this.turns.run(
        {
          audio: pcmToWav(pcm),
          mimeType: "audio/wav",
          ...(this.locale === undefined ? {} : { locale: this.locale }),
        },
        requestId,
        this.context,
        {
          onTranscript: (transcript) => {
            if (!this.closed)
              this.emit("transcript.final", turnId, {
                text: transcript.text,
                detectedLanguage: transcript.detectedLanguage,
              });
          },
          onAgentStarted: () => {
            failureCode = "VOICE_AGENT_FAILED";
            if (!this.closed) this.emit("agent.started", turnId);
          },
          onAgentCompleted: (responseText) => {
            if (!this.closed)
              this.emit("agent.completed", turnId, { text: responseText });
          },
          onSynthesisStarted: () => {
            failureCode = "VOICE_TTS_FAILED";
            if (!this.closed) this.emit("tts.started", turnId);
          },
        },
      );
      if (this.closed) return;
      this.state = "SPEAKING";
      const audio = Buffer.from(result.audioBase64, "base64");
      this.emit("audio.started", turnId, {
        mimeType: result.audioMimeType,
        delivery: "chunked-complete-wav",
      });
      for (
        let offset = 0;
        offset < audio.length;
        offset += this.limits.audioChunkBytes
      )
        this.sink.audio(
          audio.subarray(offset, offset + this.limits.audioChunkBytes),
        );
      this.emit("audio.completed", turnId, { audioBytes: audio.length });
      this.emit("turn.completed", turnId);
      this.state = "READY";
      this.turnId = undefined;
    } catch {
      if (!this.closed) {
        this.error(failureCode, turnId);
        this.state = "READY";
        this.turnId = undefined;
      }
    }
  }
  private failTurn(code: string): void {
    this.error(code, this.turnId);
    this.chunks = [];
    this.bytes = 0;
    this.frames = 0;
    this.turnId = undefined;
    this.vad.reset();
    this.state = "READY";
  }
  private error(code: string, turnId?: string): void {
    this.emit("error", turnId, { code });
  }
  private emit(
    type: string,
    turnId?: string,
    payload?: Record<string, unknown>,
  ): void {
    this.sink.event({
      protocol: VOICE_PROTOCOL,
      type,
      sessionId: this.sessionId,
      requestId:
        turnId === undefined
          ? this.rootRequestId
          : `${this.rootRequestId}:${turnId}`,
      ...(turnId === undefined ? {} : { turnId }),
      ...(payload === undefined ? {} : { payload }),
    });
  }
}
