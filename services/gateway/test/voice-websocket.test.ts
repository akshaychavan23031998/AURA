import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app/create-app.js";
import {
  testAuthorizationHeader,
  testTokenVerifier,
} from "./auth-test-helpers.js";
import { testConfig } from "./test-config.js";

const speech = Buffer.alloc(640);
for (let offset = 0; offset < speech.length; offset += 2)
  speech.writeInt16LE(2000, offset);
const silence = Buffer.alloc(640);
const opened: WebSocket[] = [];

afterEach(() => {
  for (const socket of opened) {
    socket.on("error", () => undefined);
    if (socket.readyState === WebSocket.OPEN) socket.terminate();
  }
  opened.length = 0;
});

async function fixture() {
  const app = await createApp({
    config: {
      ...testConfig,
      voiceStream: {
        ...testConfig.voiceStream,
        vadMinSpeechMs: 40,
        vadEndSilenceMs: 40,
      },
    },
    logger: false,
    tokenVerifier: testTokenVerifier,
    voiceClient: {
      transcribe: vi.fn().mockResolvedValue({
        text: "echo AURA",
        detectedLanguage: "en",
        durationMs: 40,
      }),
      synthesize: vi.fn().mockResolvedValue(Buffer.from("RIFFvoice")),
    },
    agentClient: {
      respond: vi.fn().mockResolvedValue({
        requestId: "downstream",
        intent: "respond",
        response: "AURA",
        plan: { type: "respond" },
      }),
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return { app, url: `ws://127.0.0.1:${port}/api/v1/voice/session` };
}

function connect(url: string, authorized = true): WebSocket {
  const socket = new WebSocket(url, {
    headers: authorized
      ? { ...testAuthorizationHeader, "x-request-id": "voice-ws-root" }
      : {},
  });
  opened.push(socket);
  return socket;
}

describe("voice WebSocket transport", () => {
  it("rejects an unauthenticated upgrade", async () => {
    const { app, url } = await fixture();
    const status = await new Promise<number>((resolve) =>
      connect(url, false).once("unexpected-response", (_request, response) =>
        resolve(response.statusCode ?? 0),
      ),
    );
    expect(status).toBe(401);
    await app.close();
  });

  it("runs one framed turn and preserves correlated protocol events", async () => {
    const { app, url } = await fixture();
    const socket = connect(url);
    const events: Array<Record<string, unknown>> = [];
    const audio: Buffer[] = [];
    socket.on("message", (data, binary) => {
      if (binary) audio.push(Buffer.from(data as ArrayBuffer));
      else
        events.push(
          JSON.parse(
            Buffer.from(data as ArrayBuffer).toString("utf8"),
          ) as Record<string, unknown>,
        );
    });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(
      JSON.stringify({ protocol: "aura.voice.v1", type: "session.start" }),
    );
    socket.send(speech);
    socket.send(speech);
    socket.send(silence);
    socket.send(silence);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "turn.completed")).toBe(
        true,
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "session.ready",
      "speech.started",
      "speech.ended",
      "transcript.final",
      "agent.started",
      "agent.completed",
      "tts.started",
      "audio.started",
      "audio.completed",
      "turn.completed",
    ]);
    expect(
      events.every((event) =>
        String(event.requestId).startsWith("voice-ws-root"),
      ),
    ).toBe(true);
    expect(Buffer.concat(audio).toString()).toBe("RIFFvoice");
    socket.close();
    await app.close();
  });

  it("returns protocol errors for malformed events and invalid frames", async () => {
    const { app, url } = await fixture();
    const socket = connect(url);
    const errors: string[] = [];
    socket.on("message", (data, binary) => {
      if (!binary) {
        const event = JSON.parse(
          Buffer.from(data as ArrayBuffer).toString("utf8"),
        ) as {
          type: string;
          payload?: { code?: string };
        };
        if (event.type === "error" && event.payload?.code)
          errors.push(event.payload.code);
      }
    });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send("not-json");
    socket.send(
      JSON.stringify({ protocol: "aura.voice.v1", type: "session.start" }),
    );
    socket.send(Buffer.alloc(641));
    await vi.waitFor(() =>
      expect(errors).toEqual(["VOICE_INVALID_EVENT", "VOICE_INVALID_FRAME"]),
    );
    socket.close();
    await app.close();
  });
});
