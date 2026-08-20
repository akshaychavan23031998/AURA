import { describe, expect, it, vi } from "vitest";
import type { AgentServiceClient } from "../src/clients/agent/agent-service-client.js";
import type { ToolServiceClient } from "../src/clients/tools/tool-service-client.js";
import type { VoiceServiceClient } from "../src/clients/voice/voice-service-client.js";
import type { MemoryStore } from "../src/memory/memory-service.js";
import { AgentToolOrchestrator } from "../src/orchestration/agent-tool-orchestrator.js";
import { VoiceTurnService } from "../src/orchestration/voice-turn-service.js";
import {
  VoiceSessionCoordinator,
  type SessionLimits,
} from "../src/voice/session-coordinator.js";

const limits: SessionLimits = {
  frameBytes: 640,
  maxFrameBytes: 640,
  maxBufferBytes: 64_000,
  maxUtteranceMs: 2_000,
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
for (let offset = 0; offset < speech.length; offset += 2)
  speech.writeInt16LE(2_000, offset);
const silence = Buffer.alloc(640);

function sendTurn(session: VoiceSessionCoordinator): void {
  session.acceptAudio(speech);
  session.acceptAudio(speech);
  session.acceptAudio(silence);
  session.acceptAudio(silence);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("safe voice turn cancellation", () => {
  it("aborts initial Agent planning before any Tool dispatch", async () => {
    const respond = vi.fn<AgentServiceClient["respond"]>(
      (_request, _requestId, signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("superseded", "AbortError")),
            {
              once: true,
            },
          ),
        ),
    );
    const execute = vi.fn<ToolServiceClient["execute"]>();
    const synthesize = vi.fn();
    const voice: VoiceServiceClient = {
      transcribe: vi.fn().mockResolvedValue({
        text: "first",
        detectedLanguage: "en",
        durationMs: 40,
      }),
      synthesize,
    };
    const { session, events } = fixture(voice, { respond }, { execute });
    session.start();
    sendTurn(session);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    session.acceptAudio(speech);
    session.acceptAudio(speech);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "turn.interrupted")).toBe(
        true,
      ),
    );
    expect(respond.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("never aborts or retries an in-flight Tool and suppresses stale completion", async () => {
    const tool = deferred<{ status: "success"; tool: string; data: unknown }>();
    const respond = vi
      .fn<AgentServiceClient["respond"]>()
      .mockResolvedValueOnce({
        requestId: "r",
        intent: "tool",
        response: "",
        plan: {
          type: "tool",
          tool: { name: "system.echo", input: { message: "one" } },
        },
      })
      .mockResolvedValue({
        requestId: "r",
        intent: "respond",
        response: "second",
        plan: { type: "respond" },
      });
    const execute = vi.fn<ToolServiceClient["execute"]>(() => tool.promise);
    const synthesize = vi.fn().mockResolvedValue(Buffer.from("RIFFsecond"));
    const voice: VoiceServiceClient = {
      transcribe: vi.fn().mockResolvedValue({
        text: "speech",
        detectedLanguage: "en",
        durationMs: 40,
      }),
      synthesize,
    };
    const { session, events } = fixture(voice, { respond }, { execute });
    session.start();
    sendTurn(session);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    sendTurn(session);
    expect(respond).toHaveBeenCalledOnce();
    tool.resolve({
      status: "success",
      tool: "system.echo",
      data: { echoed: true },
    });
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) => event.type === "turn.action_completed_after_interrupt",
        ),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        events.filter((event) => event.type === "turn.completed"),
      ).toHaveLength(1),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(synthesize).toHaveBeenCalledOnce();
    const interruptedId = events.find(
      (event) => event.type === "turn.interrupted",
    )?.turnId;
    expect(
      events.some(
        (event) =>
          event.turnId === interruptedId &&
          [
            "agent.completed",
            "tts.started",
            "audio.started",
            "turn.completed",
          ].includes(event.type),
      ),
    ).toBe(false);
  });

  it("aborts TTS and emits no stale audio", async () => {
    const synthesize = vi.fn<VoiceServiceClient["synthesize"]>(
      (_text, _locale, _requestId, signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("superseded", "AbortError")),
            {
              once: true,
            },
          ),
        ),
    );
    const voice: VoiceServiceClient = {
      transcribe: vi.fn().mockResolvedValue({
        text: "first",
        detectedLanguage: "en",
        durationMs: 40,
      }),
      synthesize,
    };
    const respond = vi.fn<AgentServiceClient["respond"]>().mockResolvedValue({
      requestId: "r",
      intent: "respond",
      response: "hello",
      plan: { type: "respond" },
    });
    const { session, events, audio } = fixture(
      voice,
      { respond },
      { execute: vi.fn() },
    );
    session.start();
    sendTurn(session);
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledOnce());
    session.acceptAudio(speech);
    session.acceptAudio(speech);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "turn.interrupted")).toBe(
        true,
      ),
    );
    expect(synthesize.mock.calls[0]?.[3]?.aborted).toBe(true);
    expect(audio).toHaveLength(0);
    expect(events.some((event) => event.type === "audio.started")).toBe(false);
  });

  it("cancels safe dependencies on disconnect without retrying Tool execution", async () => {
    const respond = vi.fn<AgentServiceClient["respond"]>(
      (_request, _requestId, signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("superseded", "AbortError")),
            {
              once: true,
            },
          ),
        ),
    );
    const execute = vi.fn<ToolServiceClient["execute"]>();
    const voice: VoiceServiceClient = {
      transcribe: vi.fn().mockResolvedValue({
        text: "first",
        detectedLanguage: "en",
        durationMs: 40,
      }),
      synthesize: vi.fn(),
    };
    const { session } = fixture(voice, { respond }, { execute });
    session.start();
    sendTurn(session);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    session.close();
    expect(respond.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not retry a failed or ambiguous Tool after interruption", async () => {
    const tool = deferred<{ status: "success"; tool: string; data: unknown }>();
    const respond = vi.fn<AgentServiceClient["respond"]>().mockResolvedValue({
      requestId: "r",
      intent: "tool",
      response: "",
      plan: {
        type: "tool",
        tool: { name: "system.echo", input: { message: "one" } },
      },
    });
    const execute = vi.fn<ToolServiceClient["execute"]>(() => tool.promise);
    const synthesize = vi.fn();
    const voice: VoiceServiceClient = {
      transcribe: vi.fn().mockResolvedValue({
        text: "first",
        detectedLanguage: "en",
        durationMs: 40,
      }),
      synthesize,
    };
    const { session, events } = fixture(voice, { respond }, { execute });
    session.start();
    sendTurn(session);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    session.acceptAudio(speech);
    session.acceptAudio(speech);
    tool.reject(new TypeError("ambiguous network failure"));
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "turn.interrupted")).toBe(
        true,
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(execute).toHaveBeenCalledOnce();
    expect(synthesize).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
  });

  it("disconnects during Tool execution without aborting or replaying it", async () => {
    const tool = deferred<{ status: "success"; tool: string; data: unknown }>();
    const respond = vi.fn<AgentServiceClient["respond"]>().mockResolvedValue({
      requestId: "r",
      intent: "tool",
      response: "",
      plan: {
        type: "tool",
        tool: { name: "system.echo", input: { message: "one" } },
      },
    });
    const execute = vi.fn<ToolServiceClient["execute"]>(() => tool.promise);
    const voice: VoiceServiceClient = {
      transcribe: vi.fn().mockResolvedValue({
        text: "first",
        detectedLanguage: "en",
        durationMs: 40,
      }),
      synthesize: vi.fn(),
    };
    const { session } = fixture(voice, { respond }, { execute });
    session.start();
    sendTurn(session);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    session.close();
    tool.resolve({ status: "success", tool: "system.echo", data: {} });
    await new Promise((resolve) => setImmediate(resolve));
    expect(execute).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledOnce();
  });

  it("disconnects during an explicit memory write without duplicating or continuing it", async () => {
    const persisted = deferred<Awaited<ReturnType<MemoryStore["create"]>>>();
    const respond = vi.fn<AgentServiceClient["respond"]>().mockResolvedValue({
      requestId: "r",
      intent: "memory",
      response: "",
      plan: {
        type: "memory_create",
        kind: "preference",
        content: "Prefers morning meetings",
      },
    });
    const create = vi.fn<MemoryStore["create"]>(() => persisted.promise);
    const memories: MemoryStore = {
      create,
      getOwned: vi.fn(),
      listOwned: vi.fn(),
      deleteOwned: vi.fn(),
    };
    const synthesize = vi.fn();
    const voice: VoiceServiceClient = {
      transcribe: vi.fn().mockResolvedValue({
        text: "remember that I prefer morning meetings",
        detectedLanguage: "en",
        durationMs: 40,
      }),
      synthesize,
    };
    const { session } = fixture(
      voice,
      { respond },
      { execute: vi.fn() },
      memories,
    );
    session.start();
    sendTurn(session);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    session.close();
    persisted.resolve({
      id: "00000000-0000-4000-8000-000000000010",
      kind: "preference",
      content: "Prefers morning meetings",
      source: "user_explicit",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(create).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledOnce();
    expect(synthesize).not.toHaveBeenCalled();
  });
});

function fixture(
  voice: VoiceServiceClient,
  agent: AgentServiceClient,
  tools: ToolServiceClient,
  memories?: MemoryStore,
) {
  const events: Array<{ type: string; turnId?: string }> = [];
  const audio: Buffer[] = [];
  const turns = new VoiceTurnService(
    voice,
    new AgentToolOrchestrator({
      agentClient: agent,
      toolClient: tools,
      ...(memories === undefined ? {} : { memories }),
    }),
  );
  const session = new VoiceSessionCoordinator(
    "root",
    {
      actorId: "actor",
      grantedPermissions: ["system.echo", "memory.write"],
    },
    turns,
    {
      event: (event) => events.push(event),
      audio: (chunk) => audio.push(chunk),
      close: vi.fn(),
    },
    limits,
  );
  return { session, events, audio };
}
