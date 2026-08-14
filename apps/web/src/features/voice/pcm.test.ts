import { describe, expect, it } from "vitest";
import { floatToPcm16, PcmFrameEncoder, resampleMono } from "./pcm";

describe("browser PCM pipeline", () => {
  it("clips and converts float samples to signed PCM16", () => {
    expect(
      Array.from(
        new Int16Array(floatToPcm16(new Float32Array([-2, -1, 0, 1, 2]))),
      ),
    ).toEqual([-32768, -32768, 0, 32767, 32767]);
  });
  it("resamples 48 kHz mono and emits exact 640-byte frames", () => {
    const encoder = new PcmFrameEncoder(48_000);
    const frames = encoder.push(new Float32Array(1_920).fill(0.25));
    expect(frames).toHaveLength(2);
    expect(frames.every((frame) => frame.byteLength === 640)).toBe(true);
  });
  it("carries incomplete input across worklet messages", () => {
    const encoder = new PcmFrameEncoder(44_100);
    expect(encoder.push(new Float32Array(400))).toHaveLength(0);
    expect(encoder.push(new Float32Array(482))).toHaveLength(1);
  });
  it("rejects unsupported sample rates", () => {
    expect(() => resampleMono(new Float32Array(100), 8_000, 320)).toThrow(
      /sample rate/i,
    );
  });
});
