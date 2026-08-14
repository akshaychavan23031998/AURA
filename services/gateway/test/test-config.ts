import type { GatewayConfig } from "../src/config/index.js";

export const testConfig: GatewayConfig = {
  runtime: { environment: "test" },
  server: { host: "127.0.0.1", port: 4000, bodyLimit: 65_536 },
  logging: { level: "silent" },
  toolsService: {
    url: "http://127.0.0.1:4001",
    token: "gateway-test-token-at-least-32-characters",
    timeoutMs: 1000,
  },
  agentService: {
    url: "http://127.0.0.1:8001",
    token: "agent-test-token-at-least-32-characters",
    timeoutMs: 1000,
  },
  voiceService: {
    url: "http://127.0.0.1:8002",
    token: "voice-test-token-at-least-32-characters",
    timeoutMs: 1000,
    maxAudioBytes: 10 * 1024 * 1024,
  },
  voiceStream: {
    frameBytes: 640,
    maxFrameBytes: 640,
    maxBufferBytes: 960_000,
    maxUtteranceMs: 30_000,
    audioChunkBytes: 16_384,
    vadThreshold: 500,
    vadMinSpeechMs: 100,
    vadEndSilenceMs: 600,
    frameMs: 20,
    idleTimeoutMs: 120_000,
    bargeInEnabled: true,
    bargeInMinSpeechMs: 100,
    interruptSettleTimeoutMs: 5_000,
  },
  auth: {
    secret: "gateway-jwt-test-secret-at-least-32-characters",
    issuer: "aura-gateway",
    audience: "aura-api",
    accessTokenTtlSeconds: 900,
    sessionTtlSeconds: 604_800,
  },
  database: { url: "postgresql://aura:aura@127.0.0.1:5432/aura_test" },
};
