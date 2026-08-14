import { describe, expect, it, vi } from "vitest";
import { VoicePlayback, type AudioElementLike } from "./playback";

function fixture() {
  const audio: AudioElementLike = {
    src: "",
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    currentTime: 0,
    onended: null,
  };
  const platform = {
    createAudio: () => audio,
    createUrl: vi.fn(() => "blob:aura"),
    revokeUrl: vi.fn(),
  };
  return { playback: new VoicePlayback(platform), audio, platform };
}
describe("voice playback", () => {
  it("queues chunks in order and plays only the current turn", async () => {
    const { playback, audio } = fixture();
    playback.begin("turn-1");
    playback.append(new Uint8Array([1]).buffer);
    playback.append(new Uint8Array([2]).buffer);
    await playback.complete("turn-1");
    expect(audio.play).toHaveBeenCalledOnce();
  });
  it("stops and discards superseded audio", async () => {
    const { playback, audio, platform } = fixture();
    playback.begin("turn-1");
    playback.append(new Uint8Array([1]).buffer);
    playback.stop("turn-1");
    await playback.complete("turn-1");
    expect(audio.pause).not.toHaveBeenCalled();
    expect(platform.createUrl).not.toHaveBeenCalled();
  });
  it("does not let a stale turn stop current playback", () => {
    const { playback, audio } = fixture();
    playback.begin("turn-2");
    playback.stop("turn-1");
    expect(audio.pause).not.toHaveBeenCalled();
  });
});
