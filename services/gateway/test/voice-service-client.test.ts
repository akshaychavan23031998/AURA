import { describe, expect, it, vi } from "vitest";
import { createVoiceServiceClient } from "../src/clients/voice/voice-service-client.js";
import { testConfig } from "./test-config.js";

describe("Voice Service client", () => {
  it("sends dedicated trust and request headers for STT", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            text: "hello",
            detectedLanguage: "en",
            durationMs: 100,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-request-id": "voice-client-1",
            },
          },
        ),
      ),
    );
    const result = await createVoiceServiceClient(
      testConfig,
      fetchMock,
    ).transcribe(Buffer.from("RIFF"), "audio/wav", "voice-client-1");
    expect(result.text).toBe("hello");
    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("x-aura-service-id")).toBe(
      "gateway",
    );
    expect(new Headers(request?.headers).get("x-aura-service-token")).toBe(
      testConfig.voiceService.token,
    );
  });
  it("accepts bounded correlated WAV synthesis", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(Uint8Array.from(Buffer.from("RIFFaudio")), {
          status: 200,
          headers: {
            "content-type": "audio/wav",
            "x-request-id": "voice-client-2",
          },
        }),
      ),
    );
    await expect(
      createVoiceServiceClient(testConfig, fetchMock).synthesize(
        "hello",
        "en",
        "voice-client-2",
      ),
    ).resolves.toEqual(Buffer.from("RIFFaudio"));
  });
  it("rejects malformed STT responses", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ text: "hello" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "voice-client-3",
          },
        }),
      ),
    );
    await expect(
      createVoiceServiceClient(testConfig, fetchMock).transcribe(
        Buffer.from("RIFF"),
        "audio/wav",
        "voice-client-3",
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_PROTOCOL_ERROR" });
  });
});
