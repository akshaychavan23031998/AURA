import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { TrustedToolContext } from "../clients/tools/tool-service-client.js";
import type {
  ApprovalRealtimeRegistry,
  RealtimeApprovalListener,
} from "../approvals/approval-realtime-registry.js";
import type { VoiceTurnService } from "../orchestration/voice-turn-service.js";
import {
  type CancellationReason,
  type TurnCancellationState,
  type TurnExecutionPhase,
} from "./cancellation.js";
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
  bargeInEnabled: boolean;
  bargeInMinSpeechMs: number;
  interruptSettleTimeoutMs: number;
}
export interface SessionSink {
  event(event: VoiceServerEvent): void;
  audio(chunk: Buffer): void;
  close(): void;
}

interface TurnExecution {
  readonly turnId: string;
  readonly controller: AbortController;
  phase: TurnExecutionPhase;
  cancellation: TurnCancellationState;
  toolDispatched: boolean;
  toolCompleted: boolean;
  audioChunksSuppressed: number;
}

export class VoiceSessionCoordinator {
  public state: VoiceSessionState = "CONNECTED";
  public readonly sessionId = randomUUID();
  private inputVad: EnergyVad;
  private interruptVad: EnergyVad;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private frames = 0;
  private inputTurnId: string | undefined;
  private execution: TurnExecution | undefined;
  private queuedTurnReady = false;
  private cancellationTimer: NodeJS.Timeout | undefined;
  private pendingApproval:
    | {
        id: string;
        turnId: string;
        execution: TurnExecution;
        listener: RealtimeApprovalListener;
        expiryTimer: NodeJS.Timeout;
      }
    | undefined;
  private closed = false;

  public constructor(
    private readonly rootRequestId: string,
    private readonly context: TrustedToolContext,
    private readonly turns: VoiceTurnService,
    private readonly sink: SessionSink,
    private readonly limits: SessionLimits,
    private locale?: string,
    private readonly realtimeApprovals?: ApprovalRealtimeRegistry,
  ) {
    this.inputVad = this.createVad(limits.vadMinSpeechMs);
    this.interruptVad = this.createVad(limits.bargeInMinSpeechMs);
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
      bargeIn: this.limits.bargeInEnabled,
    });
  }

  public acceptAudio(frame: Buffer): void {
    if (this.closed) return;
    if (
      frame.length > this.limits.maxFrameBytes ||
      frame.length !== this.limits.frameBytes
    )
      return this.error("VOICE_INVALID_FRAME", this.execution?.turnId);
    if (
      this.execution !== undefined &&
      (this.state === "PROCESSING" ||
        this.state === "SPEAKING" ||
        this.state === "INTERRUPTING")
    ) {
      this.acceptBargeIn(frame);
      return;
    }
    if (this.state === "AWAITING_APPROVAL")
      return this.error("VOICE_APPROVAL_PENDING", this.execution?.turnId);
    if (this.state !== "READY" && this.state !== "LISTENING")
      return this.error("VOICE_INVALID_FRAME");
    this.acceptInput(frame);
  }

  public close(): void {
    this.closed = true;
    this.execution?.controller.abort(
      new DOMException("Session disconnected", "AbortError"),
    );
    clearTimeout(this.cancellationTimer);
    this.detachPendingApproval();
    this.state = "CLOSED";
    this.resetInput();
    this.interruptVad.reset();
  }

  private acceptBargeIn(frame: Buffer): void {
    if (!this.limits.bargeInEnabled) return;
    const decision = this.interruptVad.accept(frame);
    if (decision !== "speech.started") return;
    const execution = this.execution;
    if (execution === undefined || execution.cancellation !== "ACTIVE") return;
    this.interrupt(execution, "BARGE_IN");
    this.inputTurnId = randomUUID();
    this.state = "LISTENING";
    this.inputVad = this.interruptVad;
    this.interruptVad = this.createVad(this.limits.bargeInMinSpeechMs);
    this.appendFrame(frame);
    this.emit("speech.started", this.inputTurnId);
  }

  private interrupt(
    execution: TurnExecution,
    reason: CancellationReason,
  ): void {
    const startedAt = performance.now();
    execution.cancellation = "INTERRUPTING";
    this.state = "INTERRUPTING";
    this.emit("turn.interrupting", execution.turnId, {
      phase: execution.phase.toLowerCase(),
      reason: reason.toLowerCase(),
      toolDispatched: execution.toolDispatched,
    });
    execution.controller.abort(
      new DOMException("Turn superseded", "AbortError"),
    );
    execution.cancellation = "SUPERSEDED";
    this.emit("turn.interrupted", execution.turnId, {
      phase: execution.phase.toLowerCase(),
      interruptLatencyMs: performance.now() - startedAt,
    });
    this.emit("turn.superseded", execution.turnId, {
      toolDispatched: execution.toolDispatched,
      toolCompleted: execution.toolCompleted,
    });
    this.cancellationTimer = setTimeout(() => {
      if (this.execution === execution) {
        this.error("VOICE_CANCELLATION_TIMEOUT", execution.turnId);
        this.close();
        this.sink.close();
      }
    }, this.limits.interruptSettleTimeoutMs);
    this.cancellationTimer.unref();
  }

  private acceptInput(frame: Buffer): void {
    if (this.bytes + frame.length > this.limits.maxBufferBytes)
      return this.failInput("VOICE_BUFFER_LIMIT_EXCEEDED");
    const decision = this.inputVad.accept(frame);
    if (decision === "speech.started" && this.state === "READY") {
      this.inputTurnId = randomUUID();
      this.state = "LISTENING";
      this.emit("speech.started", this.inputTurnId);
    }
    if (this.state === "LISTENING") {
      this.appendFrame(frame);
      if (this.frames * this.limits.frameMs > this.limits.maxUtteranceMs)
        return this.failInput("VOICE_TURN_TOO_LONG");
    }
    if (decision === "speech.ended" && this.inputTurnId !== undefined) {
      const turnId = this.inputTurnId;
      this.emit("speech.ended", turnId);
      if (this.execution === undefined) void this.process(turnId);
      else this.queuedTurnReady = true;
    }
  }

  private appendFrame(frame: Buffer): void {
    this.chunks.push(Buffer.from(frame));
    this.bytes += frame.length;
    this.frames += 1;
  }

  private async process(turnId: string): Promise<void> {
    const pcm = Buffer.concat(this.chunks);
    this.resetInput();
    const execution: TurnExecution = {
      turnId,
      controller: new AbortController(),
      phase: "STT",
      cancellation: "ACTIVE",
      toolDispatched: false,
      toolCompleted: false,
      audioChunksSuppressed: 0,
    };
    this.execution = execution;
    this.state = "PROCESSING";
    this.interruptVad.reset();
    const requestId = `${this.rootRequestId}:${turnId}`;
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
          onPhaseChange: (phase) => {
            execution.phase = phase;
          },
          onToolDispatched: () => {
            execution.toolDispatched = true;
          },
          onToolCompleted: () => {
            execution.toolCompleted = true;
            if (!this.closed && execution.cancellation === "SUPERSEDED")
              this.emit("turn.action_completed_after_interrupt", turnId);
          },
          onTranscript: (transcript) => {
            if (this.isCurrent(execution))
              this.emit("transcript.final", turnId, {
                text: transcript.text,
                detectedLanguage: transcript.detectedLanguage,
              });
          },
          onAgentStarted: () => {
            failureCode = "VOICE_AGENT_FAILED";
            if (this.isCurrent(execution)) this.emit("agent.started", turnId);
          },
          onAgentCompleted: (text) => {
            if (this.isCurrent(execution))
              this.emit("agent.completed", turnId, { text });
          },
          onSynthesisStarted: () => {
            failureCode = "VOICE_TTS_FAILED";
            if (this.isCurrent(execution)) this.emit("tts.started", turnId);
          },
        },
        execution.controller.signal,
      );
      if (!this.isCurrent(execution)) return;
      if ("approval" in result) {
        this.awaitApproval(result.approval, turnId, execution);
        return;
      }
      execution.phase = "AUDIO_DELIVERY";
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
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!this.isCurrent(execution)) {
          execution.audioChunksSuppressed = Math.ceil(
            (audio.length - offset) / this.limits.audioChunkBytes,
          );
          break;
        }
        this.sink.audio(
          audio.subarray(offset, offset + this.limits.audioChunkBytes),
        );
      }
      if (!this.isCurrent(execution)) return;
      this.emit("audio.completed", turnId, { audioBytes: audio.length });
      this.emit("turn.completed", turnId);
      execution.phase = "COMPLETED";
      execution.cancellation = "SETTLED";
    } catch {
      if (this.isCurrent(execution)) this.error(failureCode, turnId);
    } finally {
      if (this.pendingApproval?.execution !== execution)
        await this.settle(execution);
    }
  }

  private awaitApproval(
    approval: {
      approvalId: string;
      title: string;
      preview: string;
      expiresAt: string;
    },
    turnId: string,
    execution: TurnExecution,
  ): void {
    this.state = "AWAITING_APPROVAL";
    const listener: RealtimeApprovalListener = {
      approved: (text) => void this.resumeApproved(text),
      rejected: () => this.finishRejected(),
      failed: () => this.finishApprovalFailure(),
    };
    const expiresIn = Math.min(
      2_147_483_647,
      Math.max(0, Date.parse(approval.expiresAt) - Date.now()),
    );
    const expiryTimer = setTimeout(() => this.finishExpired(), expiresIn);
    expiryTimer.unref();
    this.pendingApproval = {
      id: approval.approvalId,
      turnId,
      execution,
      listener,
      expiryTimer,
    };
    this.realtimeApprovals?.attach(approval.approvalId, listener);
    this.emit("approval.required", turnId, approval);
  }

  private async resumeApproved(responseText: string): Promise<void> {
    const pending = this.pendingApproval;
    if (pending === undefined || this.closed) return;
    this.pendingApproval = undefined;
    clearTimeout(pending.expiryTimer);
    this.state = "PROCESSING";
    this.emit("approval.approved", pending.turnId, {
      approvalId: pending.id,
    });
    try {
      this.emit("agent.completed", pending.turnId, { text: responseText });
      this.emit("tts.started", pending.turnId);
      const audio = await this.turns.synthesizeApprovedResponse(
        responseText,
        this.locale ?? "en",
        `${this.rootRequestId}:${pending.turnId}`,
        pending.execution.controller.signal,
      );
      if (!this.isCurrent(pending.execution)) return;
      pending.execution.phase = "AUDIO_DELIVERY";
      this.state = "SPEAKING";
      this.emit("audio.started", pending.turnId, {
        mimeType: "audio/wav",
        delivery: "chunked-complete-wav",
      });
      for (
        let offset = 0;
        offset < audio.length;
        offset += this.limits.audioChunkBytes
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!this.isCurrent(pending.execution)) return;
        this.sink.audio(
          audio.subarray(offset, offset + this.limits.audioChunkBytes),
        );
      }
      this.emit("audio.completed", pending.turnId, {
        audioBytes: audio.length,
      });
      this.emit("turn.completed", pending.turnId);
      pending.execution.phase = "COMPLETED";
      pending.execution.cancellation = "SETTLED";
    } catch {
      if (!this.closed) this.error("VOICE_TTS_FAILED", pending.turnId);
    } finally {
      await this.settle(pending.execution);
    }
  }

  private finishRejected(): void {
    const pending = this.pendingApproval;
    if (pending === undefined || this.closed) return;
    this.pendingApproval = undefined;
    clearTimeout(pending.expiryTimer);
    this.emit("approval.rejected", pending.turnId, {
      approvalId: pending.id,
    });
    this.emit("agent.completed", pending.turnId, {
      text: "Okay, I won't perform that action.",
    });
    this.emit("turn.completed", pending.turnId);
    pending.execution.phase = "COMPLETED";
    pending.execution.cancellation = "SETTLED";
    void this.settle(pending.execution);
  }

  private finishExpired(): void {
    const pending = this.pendingApproval;
    if (pending === undefined || this.closed) return;
    this.realtimeApprovals?.detach(pending.id, pending.listener);
    this.pendingApproval = undefined;
    this.emit("approval.expired", pending.turnId, {
      approvalId: pending.id,
    });
    this.error("APPROVAL_EXPIRED", pending.turnId);
    pending.execution.cancellation = "SETTLED";
    void this.settle(pending.execution);
  }

  private finishApprovalFailure(): void {
    const pending = this.pendingApproval;
    if (pending === undefined || this.closed) return;
    this.pendingApproval = undefined;
    clearTimeout(pending.expiryTimer);
    this.error("APPROVAL_EXECUTION_FAILED", pending.turnId);
    pending.execution.cancellation = "SETTLED";
    void this.settle(pending.execution);
  }

  private detachPendingApproval(): void {
    const pending = this.pendingApproval;
    if (pending !== undefined)
      this.realtimeApprovals?.detach(pending.id, pending.listener);
    if (pending !== undefined) clearTimeout(pending.expiryTimer);
    this.pendingApproval = undefined;
  }

  private async settle(execution: TurnExecution): Promise<void> {
    if (this.execution !== execution) return;
    clearTimeout(this.cancellationTimer);
    this.execution = undefined;
    this.interruptVad.reset();
    if (this.closed) return;
    if (this.queuedTurnReady && this.inputTurnId !== undefined) {
      const nextTurnId = this.inputTurnId;
      this.queuedTurnReady = false;
      await this.process(nextTurnId);
      return;
    }
    if (this.state !== "LISTENING") this.state = "READY";
  }

  private isCurrent(execution: TurnExecution): boolean {
    return (
      !this.closed &&
      this.execution === execution &&
      execution.cancellation === "ACTIVE"
    );
  }

  private failInput(code: string): void {
    this.error(code, this.inputTurnId);
    this.resetInput();
    if (this.execution === undefined) this.state = "READY";
  }
  private resetInput(): void {
    this.chunks = [];
    this.bytes = 0;
    this.frames = 0;
    this.inputTurnId = undefined;
    this.inputVad.reset();
  }
  private createVad(minSpeechMs: number): EnergyVad {
    return new EnergyVad({
      frameBytes: this.limits.frameBytes,
      threshold: this.limits.vadThreshold,
      minSpeechMs,
      endSilenceMs: this.limits.vadEndSilenceMs,
      frameMs: this.limits.frameMs,
    });
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
