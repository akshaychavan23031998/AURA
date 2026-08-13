import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app/create-app.js";
import type { AgentServiceClient } from "../src/clients/agent/agent-service-client.js";
import type { ToolServiceClient } from "../src/clients/tools/tool-service-client.js";
import type { VoiceServiceClient } from "../src/clients/voice/voice-service-client.js";
import {
  testAuthorizationHeader,
  testTokenVerifier,
} from "./auth-test-helpers.js";
import { testConfig } from "./test-config.js";

function multipart(
  audio: Buffer,
  type = "audio/wav",
): { body: Buffer; contentType: string } {
  const boundary = "aura-voice-boundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\nContent-Type: ${type}\r\n\r\n`,
  );
  return {
    body: Buffer.concat([head, audio, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
function dependencies() {
  const transcribe = vi.fn<VoiceServiceClient["transcribe"]>(() =>
    Promise.resolve({
      text: "echo AURA",
      detectedLanguage: "en",
      durationMs: 100,
    }),
  );
  const synthesize = vi.fn<VoiceServiceClient["synthesize"]>(() =>
    Promise.resolve(Buffer.from("RIFFaudio")),
  );
  const respond = vi.fn<AgentServiceClient["respond"]>((_, requestId) =>
    Promise.resolve({
      requestId,
      intent: "respond",
      response: "AURA",
      plan: { type: "respond" },
    }),
  );
  const execute = vi.fn<ToolServiceClient["execute"]>();
  return {
    voiceClient: { transcribe, synthesize },
    agentClient: { respond },
    toolClient: { execute },
    transcribe,
    synthesize,
    respond,
    execute,
  };
}

describe("POST /api/v1/voice/run", () => {
  it("requires authentication", async () => {
    const deps = dependencies();
    const app = await createApp({
      config: testConfig,
      ...deps,
      tokenVerifier: testTokenVerifier,
    });
    const data = multipart(Buffer.from("RIFF"));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/voice/run",
      headers: { "content-type": data.contentType },
      payload: data.body,
    });
    expect(response.statusCode).toBe(401);
    expect(deps.transcribe).not.toHaveBeenCalled();
    await app.close();
  });
  it("runs a correlated bounded voice turn", async () => {
    const deps = dependencies();
    const app = await createApp({
      config: testConfig,
      ...deps,
      tokenVerifier: testTokenVerifier,
    });
    const data = multipart(Buffer.from("RIFFaudio"));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/voice/run",
      headers: {
        ...testAuthorizationHeader,
        "x-request-id": "voice-route-1",
        "content-type": data.contentType,
      },
      payload: data.body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("voice-route-1");
    expect(response.json()).toMatchObject({
      transcript: "echo AURA",
      responseText: "AURA",
      audioMimeType: "audio/wav",
    });
    expect(deps.transcribe).toHaveBeenCalledWith(
      Buffer.from("RIFFaudio"),
      "audio/wav",
      "voice-route-1",
      undefined,
    );
    expect(deps.synthesize).toHaveBeenCalledWith("AURA", "en", "voice-route-1");
    await app.close();
  });
  it("does not rerun the Agent when synthesis fails", async () => {
    const deps = dependencies();
    deps.synthesize.mockRejectedValueOnce(new Error("tts unavailable"));
    const app = await createApp({
      config: testConfig,
      ...deps,
      tokenVerifier: testTokenVerifier,
    });
    const data = multipart(Buffer.from("RIFFaudio"));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/voice/run",
      headers: { ...testAuthorizationHeader, "content-type": data.contentType },
      payload: data.body,
    });
    expect(response.statusCode).toBe(500);
    expect(deps.respond).toHaveBeenCalledOnce();
    expect(deps.synthesize).toHaveBeenCalledOnce();
    await app.close();
  });
});
