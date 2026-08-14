import { describe, expect, it, vi } from "vitest";
import type { VoiceTurnService } from "../src/orchestration/voice-turn-service.js";
import {
  VoiceSessionCoordinator,
  type SessionLimits,
  type SessionSink,
} from "../src/voice/session-coordinator.js";
import { EnergyVad } from "../src/voice/vad.js";
import { ApprovalRealtimeRegistry } from "../src/approvals/approval-realtime-registry.js";

const limits: SessionLimits = {
  frameBytes: 640,
  maxFrameBytes: 640,
  maxBufferBytes: 640 * 100,
  maxUtteranceMs: 1000,
  audioChunkBytes: 4,
  vadThreshold: 500,
  vadMinSpeechMs: 40,
  vadEndSilenceMs: 40,
  frameMs: 20,
  bargeInEnabled: true,
  bargeInMinSpeechMs: 40,
  interruptSettleTimeoutMs: 1_000,
};
const speech = Buffer.alloc(640);
for (let i = 0; i < 640; i += 2) speech.writeInt16LE(2000, i);
const silence = Buffer.alloc(640);

function harness(
  run = vi.fn<VoiceTurnService["run"]>(
    (_input, _requestId, _context, observer) => {
      observer?.onTranscript?.({ text: "hello", detectedLanguage: "en" });
      observer?.onAgentStarted?.();
      observer?.onAgentCompleted?.("hello");
      observer?.onSynthesisStarted?.();
      return Promise.resolve({
        transcript: "hello",
        detectedLanguage: "en",
        responseText: "hello",
        audioBase64: Buffer.from("RIFFaudio").toString("base64"),
        audioMimeType: "audio/wav",
      });
    },
  ),
) {
  const events: Array<{
    type: string;
    requestId: string;
    payload?: Record<string, unknown>;
  }> = [];
  const audio: Buffer[] = [];
  const sink: SessionSink = {
    event: (event) => events.push(event),
    audio: (chunk) => audio.push(chunk),
    close: vi.fn(),
  };
  const session = new VoiceSessionCoordinator(
    "root-1",
    { actorId: "actor", grantedPermissions: ["system.echo"] },
    { run } as unknown as VoiceTurnService,
    sink,
    limits,
  );
  return { session, events, audio, run };
}

describe("EnergyVad", () => {
  it("detects speech start and silence end", () => {
    const vad = new EnergyVad({
      frameBytes: 640,
      threshold: 500,
      minSpeechMs: 40,
      endSilenceMs: 40,
      frameMs: 20,
    });
    expect(vad.accept(speech)).toBe("silence");
    expect(vad.accept(speech)).toBe("speech.started");
    expect(vad.accept(silence)).toBe("silence");
    expect(vad.accept(silence)).toBe("speech.ended");
  });
  it("does not start on silence", () => {
    const vad = new EnergyVad({
      frameBytes: 640,
      threshold: 500,
      minSpeechMs: 20,
      endSilenceMs: 40,
      frameMs: 20,
    });
    expect(vad.accept(silence)).toBe("silence");
  });
});

describe("VoiceSessionCoordinator", () => {
  it("waits for explicit HTTP approval, rejects speech authority, then resumes audio", async () => {
    const events: Array<{ type: string; payload?: Record<string, unknown> }> =
      [];
    const audio: Buffer[] = [];
    const realtime = new ApprovalRealtimeRegistry();
    const approvalId = "00000000-0000-4000-8000-000000000099";
    const turns = {
      run: vi.fn().mockResolvedValue({
        status: "approval_required",
        transcript: "yes",
        detectedLanguage: "en",
        approval: {
          approvalId,
          title: "Confirm action",
          preview: "Run test action",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      }),
      synthesizeApprovedResponse: vi
        .fn()
        .mockResolvedValue(Buffer.from("RIFFapproved")),
    };
    const session = new VoiceSessionCoordinator(
      "approval-root",
      { actorId: "actor", grantedPermissions: ["test.approval"] },
      turns as unknown as VoiceTurnService,
      {
        event: (event) => events.push(event),
        audio: (chunk) => audio.push(chunk),
        close: vi.fn(),
      },
      limits,
      "en",
      realtime,
    );
    session.start();
    sendTurn(session);
    await vi.waitFor(() => expect(session.state).toBe("AWAITING_APPROVAL"));
    expect(
      events.find((event) => event.type === "approval.required")?.payload,
    ).toEqual(expect.objectContaining({ approvalId, title: "Confirm action" }));

    sendTurn(session);
    expect(
      events.some(
        (event) =>
          event.type === "error" &&
          event.payload?.code === "VOICE_APPROVAL_PENDING",
      ),
    ).toBe(true);
    expect(turns.synthesizeApprovedResponse).not.toHaveBeenCalled();

    realtime.approved(approvalId, "Approved action completed");
    await vi.waitFor(() => expect(session.state).toBe("READY"));
    expect(turns.synthesizeApprovedResponse).toHaveBeenCalledOnce();
    expect(
      events.filter((event) => event.type === "approval.approved"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "turn.completed"),
    ).toHaveLength(1);
    expect(audio.length).toBeGreaterThan(0);
  });

  it("does not execute or resume a pending approval after disconnect", async () => {
    const realtime = new ApprovalRealtimeRegistry();
    const synthesizeApprovedResponse = vi.fn();
    const session = new VoiceSessionCoordinator(
      "disconnect-root",
      { actorId: "actor", grantedPermissions: [] },
      {
        run: vi.fn().mockResolvedValue({
          status: "approval_required",
          transcript: "request",
          detectedLanguage: "en",
          approval: {
            approvalId: "00000000-0000-4000-8000-000000000098",
            title: "Confirm",
            preview: "Test",
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
        }),
        synthesizeApprovedResponse,
      } as unknown as VoiceTurnService,
      { event: vi.fn(), audio: vi.fn(), close: vi.fn() },
      limits,
      "en",
      realtime,
    );
    session.start();
    sendTurn(session);
    await vi.waitFor(() => expect(session.state).toBe("AWAITING_APPROVAL"));
    session.close();
    realtime.approved("00000000-0000-4000-8000-000000000098", "must not play");
    await Promise.resolve();
    expect(synthesizeApprovedResponse).not.toHaveBeenCalled();
  });

  it("enforces state and invalid frame limits", () => {
    const h = harness();
    h.session.acceptAudio(speech);
    expect(h.events.at(-1)?.payload?.code).toBe("VOICE_INVALID_FRAME");
    h.session.start();
    h.session.acceptAudio(Buffer.alloc(641));
    expect(h.events.at(-1)?.payload?.code).toBe("VOICE_INVALID_FRAME");
  });
  it("finalizes one correlated turn and chunks completed audio", async () => {
    const h = harness();
    h.session.start();
    h.session.acceptAudio(speech);
    h.session.acceptAudio(speech);
    h.session.acceptAudio(silence);
    h.session.acceptAudio(silence);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.type === "turn.completed")).toBe(
        true,
      ),
    );
    expect(h.run).toHaveBeenCalledOnce();
    const requestId = h.run.mock.calls[0]?.[1];
    expect(requestId).toMatch(/^root-1:/);
    expect(h.audio.length).toBeGreaterThan(1);
    expect(h.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "speech.started",
        "speech.ended",
        "transcript.final",
        "agent.completed",
        "audio.started",
        "audio.completed",
        "turn.completed",
      ]),
    );
  });
  it("does not interrupt processing for insufficient speech", async () => {
    let resolve!: (value: Awaited<ReturnType<VoiceTurnService["run"]>>) => void;
    const run = vi.fn<VoiceTurnService["run"]>(
      (_input, _requestId, _context, observer) =>
        new Promise((done) => {
          observer?.onTranscript?.({ text: "hello", detectedLanguage: "en" });
          observer?.onAgentStarted?.();
          resolve = done;
        }),
    );
    const h = harness(run);
    h.session.start();
    h.session.acceptAudio(speech);
    h.session.acceptAudio(speech);
    h.session.acceptAudio(silence);
    h.session.acceptAudio(silence);
    h.session.acceptAudio(speech);
    expect(h.events.some((event) => event.type === "turn.interrupted")).toBe(
      false,
    );
    expect(run).toHaveBeenCalledOnce();
    resolve({
      transcript: "hello",
      detectedLanguage: "en",
      responseText: "hello",
      audioBase64: Buffer.from("RIFFaudio").toString("base64"),
      audioMimeType: "audio/wav",
    });
    await vi.waitFor(() => expect(h.session.state).toBe("READY"));
  });
  it("cleans buffers on disconnect and never retries", async () => {
    const h = harness();
    h.session.start();
    h.session.acceptAudio(speech);
    h.session.acceptAudio(speech);
    h.session.acceptAudio(silence);
    h.session.acceptAudio(silence);
    h.session.close();
    await Promise.resolve();
    expect(h.session.state).toBe("CLOSED");
    expect(h.run).toHaveBeenCalledOnce();
  });

  it("supersedes processing after validated barge-in and accepts a replacement turn", async () => {
    const run = vi.fn<VoiceTurnService["run"]>(
      (_input, _requestId, _context, observer, signal) => {
        if (run.mock.calls.length === 1) {
          observer?.onPhaseChange?.("AGENT_INITIAL");
          observer?.onAgentStarted?.();
          return new Promise((_resolve, reject) =>
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("superseded", "AbortError")),
              {
                once: true,
              },
            ),
          );
        }
        observer?.onTranscript?.({ text: "second", detectedLanguage: "en" });
        observer?.onAgentStarted?.();
        observer?.onAgentCompleted?.("second response");
        observer?.onSynthesisStarted?.();
        return Promise.resolve({
          transcript: "second",
          detectedLanguage: "en",
          responseText: "second response",
          audioBase64: Buffer.from("RIFFsecond").toString("base64"),
          audioMimeType: "audio/wav",
        });
      },
    );
    const h = harness(run);
    h.session.start();
    sendTurn(h.session);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    sendTurn(h.session);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.type === "turn.completed")).toBe(
        true,
      ),
    );
    expect(
      h.events.filter((event) => event.type === "turn.interrupted"),
    ).toHaveLength(1);
    expect(
      h.events.filter((event) => event.type === "turn.superseded"),
    ).toHaveLength(1);
    expect(
      h.events.filter((event) => event.type === "turn.completed"),
    ).toHaveLength(1);
  });

  it("stops old audio chunks immediately after speaking is interrupted", async () => {
    const events: Array<{ type: string }> = [];
    const audio: Buffer[] = [];
    const run = vi.fn<VoiceTurnService["run"]>(
      (_input, _requestId, _context, observer) => {
        observer?.onPhaseChange?.("COMPLETED");
        return Promise.resolve({
          transcript: "first",
          detectedLanguage: "en",
          responseText: "response",
          audioBase64: Buffer.alloc(40, 1).toString("base64"),
          audioMimeType: "audio/wav",
        });
      },
    );
    const session = new VoiceSessionCoordinator(
      "root-audio",
      { actorId: "actor", grantedPermissions: [] },
      { run } as unknown as VoiceTurnService,
      {
        event: (event) => events.push(event),
        audio: (chunk) => {
          audio.push(chunk);
          if (audio.length === 3) {
            session.acceptAudio(speech);
            session.acceptAudio(speech);
          }
        },
        close: vi.fn(),
      },
      limits,
    );
    session.start();
    sendTurn(session);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "turn.interrupted")).toBe(
        true,
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(audio).toHaveLength(3);
    expect(events.some((event) => event.type === "audio.completed")).toBe(
      false,
    );
  });
});

function sendTurn(session: VoiceSessionCoordinator): void {
  session.acceptAudio(speech);
  session.acceptAudio(speech);
  session.acceptAudio(silence);
  session.acceptAudio(silence);
}
