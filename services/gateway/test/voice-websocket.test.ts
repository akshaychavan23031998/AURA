import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app/create-app.js";
import { extractWebSocketBearerProtocol } from "../src/routes/voice/voice-session.route.js";
import type { AgentServiceClient } from "../src/clients/agent/agent-service-client.js";
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

async function fixture(
  overrides: Partial<Parameters<typeof createApp>[0]> = {},
) {
  const app = await createApp({
    config: {
      ...testConfig,
      voiceStream: {
        ...testConfig.voiceStream,
        vadMinSpeechMs: 40,
        vadEndSilenceMs: 40,
        bargeInMinSpeechMs: 40,
      },
    },
    logger: false,
    tokenVerifier: testTokenVerifier,
    voiceClient: overrides.voiceClient ?? {
      transcribe: vi.fn().mockResolvedValue({
        text: "echo AURA",
        detectedLanguage: "en",
        durationMs: 40,
      }),
      synthesize: vi.fn().mockResolvedValue(Buffer.from("RIFFvoice")),
    },
    agentClient: overrides.agentClient ?? {
      respond: vi.fn().mockResolvedValue({
        requestId: "downstream",
        intent: "respond",
        response: "AURA",
        plan: { type: "respond" },
      }),
    },
    ...overrides,
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
  it("extracts exactly one bounded browser credential protocol", () => {
    expect(
      extractWebSocketBearerProtocol("aura.voice.v1, aura.jwt.one.two.three"),
    ).toBe("Bearer one.two.three");
    expect(
      extractWebSocketBearerProtocol(
        "aura.jwt.one.two.three, aura.jwt.four.five.six",
      ),
    ).toBeUndefined();
  });

  it("authenticates a browser-compatible subprotocol upgrade", async () => {
    const { app, url } = await fixture();
    const socket = new WebSocket(url, [
      "aura.voice.v1",
      "aura.jwt.test.header.signature",
    ]);
    opened.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    expect(socket.protocol).toBe("aura.voice.v1");
    socket.close();
    await app.close();
  });
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
      JSON.stringify({
        protocol: "aura.voice.v1",
        type: "session.start",
        cancellationScope: "tool",
      }),
    );
    socket.send(
      JSON.stringify({ protocol: "aura.voice.v1", type: "session.start" }),
    );
    socket.send(Buffer.alloc(641));
    await vi.waitFor(() =>
      expect(errors).toEqual([
        "VOICE_INVALID_EVENT",
        "VOICE_INVALID_EVENT",
        "VOICE_INVALID_FRAME",
      ]),
    );
    socket.close();
    await app.close();
  });

  it("interrupts processing and completes a buffered replacement turn", async () => {
    const respond = vi.fn<AgentServiceClient["respond"]>(
      (_request, _requestId, signal) => {
        if (respond.mock.calls.length === 1)
          return new Promise((_resolve, reject) =>
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("superseded", "AbortError")),
              {
                once: true,
              },
            ),
          );
        return Promise.resolve({
          requestId: "second",
          intent: "respond",
          response: "second response",
          plan: { type: "respond" as const },
        });
      },
    );
    const { app, url } = await fixture({ agentClient: { respond } });
    const socket = connect(url);
    const events: Array<{ type: string }> = [];
    socket.on("message", (data, binary) => {
      if (!binary)
        events.push(
          JSON.parse(Buffer.from(data as ArrayBuffer).toString("utf8")) as {
            type: string;
          },
        );
    });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(
      JSON.stringify({ protocol: "aura.voice.v1", type: "session.start" }),
    );
    sendSocketTurn(socket);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    sendSocketTurn(socket);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "turn.interrupted")).toBe(
        true,
      ),
    );
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        events.filter((event) => event.type === "turn.completed"),
      ).toHaveLength(1),
    );
    socket.close();
    await app.close();
  });

  it("stops WebSocket audio delivery when speaking is interrupted", async () => {
    const audioPayload = Buffer.alloc(80_000, 1);
    const { app, url } = await fixture({
      voiceClient: {
        transcribe: vi.fn().mockResolvedValue({
          text: "hello",
          detectedLanguage: "en",
          durationMs: 40,
        }),
        synthesize: vi.fn().mockResolvedValue(audioPayload),
      },
    });
    const socket = connect(url);
    const events: Array<{ type: string }> = [];
    let audioChunks = 0;
    socket.on("message", (data, binary) => {
      if (binary) {
        audioChunks += 1;
        if (audioChunks === 1) {
          socket.send(speech);
          socket.send(speech);
        }
      } else
        events.push(
          JSON.parse(Buffer.from(data as ArrayBuffer).toString("utf8")) as {
            type: string;
          },
        );
    });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(
      JSON.stringify({ protocol: "aura.voice.v1", type: "session.start" }),
    );
    sendSocketTurn(socket);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "turn.interrupted")).toBe(
        true,
      ),
    );
    const chunksAtInterrupt = audioChunks;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(audioChunks).toBe(chunksAtInterrupt);
    expect(audioChunks).toBeLessThan(
      Math.ceil(audioPayload.length / testConfig.voiceStream.audioChunkBytes),
    );
    socket.close();
    await app.close();
  });
});

function sendSocketTurn(socket: WebSocket): void {
  socket.send(speech);
  socket.send(speech);
  socket.send(silence);
  socket.send(silence);
}
