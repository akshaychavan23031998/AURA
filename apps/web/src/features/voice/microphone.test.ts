import { afterEach, describe, expect, it, vi } from "vitest";
import { MicrophoneCapture } from "./microphone";

afterEach(() => {
  vi.unstubAllGlobals();
});
describe("MicrophoneCapture", () => {
  it.each([
    ["NotAllowedError", "permission-denied"],
    ["NotFoundError", "not-found"],
  ])("maps %s without retaining audio", async (name, code) => {
    vi.stubGlobal("AudioWorkletNode", class {});
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(new DOMException("failed", name)),
      },
    });
    await expect(new MicrophoneCapture().start(vi.fn())).rejects.toMatchObject({
      code,
    });
  });
  it("reports unsupported browser capture", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
    await expect(new MicrophoneCapture().start(vi.fn())).rejects.toMatchObject({
      code: "unsupported",
    });
  });
});
