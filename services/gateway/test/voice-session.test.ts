import { describe, expect, it, vi } from "vitest";
import type { VoiceTurnService } from "../src/orchestration/voice-turn-service.js";
import {
  VoiceSessionCoordinator,
  type SessionLimits,
  type SessionSink,
} from "../src/voice/session-coordinator.js";
import { EnergyVad } from "../src/voice/vad.js";

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
  it("rejects audio while processing without duplicate orchestration", async () => {
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
    expect(h.events.at(-1)?.payload?.code).toBe("VOICE_BUSY");
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
});
