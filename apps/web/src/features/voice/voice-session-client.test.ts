import { describe, expect, it, vi } from "vitest";
import type { MicrophoneCapture } from "./microphone";
import type { VoicePlayback } from "./playback";
import {
  VoiceSessionClient,
  type VoiceSessionDependencies,
} from "./voice-session-client";

class FakeSocket {
  public binaryType = "";
  public readyState: number = WebSocket.CONNECTING;
  public sent: unknown[] = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;
  public send(data: unknown) {
    this.sent.push(data);
  }
  public close(code = 1000) {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
  public open() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }
  public message(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function fixture() {
  const socket = new FakeSocket();
  let onFrame: ((frame: ArrayBuffer) => void) | undefined;
  const microphone = {
    start: vi.fn((callback) => {
      onFrame = callback;
      return Promise.resolve();
    }),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as MicrophoneCapture;
  const playback = {
    begin: vi.fn(),
    append: vi.fn(),
    complete: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  } as unknown as VoicePlayback;
  const createSocket = vi.fn(() => socket as unknown as WebSocket);
  const transitions = vi.fn();
  const dependencies: VoiceSessionDependencies = {
    createSocket,
    microphone,
    playback,
  };
  const client = new VoiceSessionClient(
    "ws://localhost:4000/api/v1/voice/session",
    "one.two.three",
    { onTransition: transitions },
    dependencies,
  );
  return {
    client,
    socket,
    microphone,
    playback,
    createSocket,
    transitions,
    frame: () => onFrame?.(new ArrayBuffer(640)),
  };
}
const event = (type: string, turnId?: string) =>
  JSON.stringify({
    protocol: "aura.voice.v1",
    type,
    sessionId: "00000000-0000-4000-8000-000000000001",
    requestId: "request",
    ...(turnId === undefined ? {} : { turnId }),
  });

describe("VoiceSessionClient", () => {
  it("uses authenticated protocols, starts capture, and sends exact frames", async () => {
    const h = fixture();
    await h.client.connect("en-IN");
    expect(h.createSocket).toHaveBeenCalledWith(expect.any(String), [
      "aura.voice.v1",
      "aura.jwt.one.two.three",
    ]);
    h.socket.open();
    h.frame();
    expect(h.socket.sent[0]).toBe(
      JSON.stringify({
        protocol: "aura.voice.v1",
        type: "session.start",
        locale: "en-IN",
      }),
    );
    expect(h.socket.sent[1]).toBeInstanceOf(ArrayBuffer);
  });
  it("stops stale playback on authoritative interruption", async () => {
    const h = fixture();
    await h.client.connect();
    h.socket.open();
    h.socket.message(
      event("audio.started", "00000000-0000-4000-8000-000000000002"),
    );
    h.socket.message(new ArrayBuffer(12));
    h.socket.message(
      event("turn.interrupted", "00000000-0000-4000-8000-000000000002"),
    );
    expect(h.playback.begin).toHaveBeenCalledOnce();
    expect(h.playback.append).toHaveBeenCalledOnce();
    expect(h.playback.stop).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000002",
    );
  });
  it("does not reconnect or replay after abnormal close", async () => {
    const h = fixture();
    await h.client.connect();
    h.socket.open();
    h.frame();
    h.socket.close(1006);
    await vi.waitFor(() => expect(h.microphone.stop).toHaveBeenCalled());
    expect(h.createSocket).toHaveBeenCalledOnce();
    expect(h.transitions).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "error" }),
    );
  });
  it("reports authenticated policy closure as session expiry", async () => {
    const h = fixture();
    await h.client.connect();
    h.socket.open();
    h.socket.close(1008);
    await vi.waitFor(() =>
      expect(h.transitions).toHaveBeenLastCalledWith(
        expect.objectContaining({ error: expect.stringMatching(/expired/i) }),
      ),
    );
  });
  it("closes and releases capture explicitly", async () => {
    const h = fixture();
    await h.client.connect();
    h.socket.open();
    await h.client.disconnect();
    expect(h.microphone.stop).toHaveBeenCalled();
    expect(h.transitions).toHaveBeenLastCalledWith({ status: "disconnected" });
  });
});
