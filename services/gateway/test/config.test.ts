import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/index.js";
import { ConfigurationError, parseEnvironment } from "../src/config/env.js";

describe("gateway configuration", () => {
  it("loads a valid, typed configuration", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: "8080",
      GATEWAY_TRUST_PROXY: "10.20.0.0/24",
      LOG_LEVEL: "warn",
      TOOLS_SERVICE_URL: "http://127.0.0.1:4001",
      TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
      TOOLS_SERVICE_TIMEOUT_MS: "2500",
      AGENT_SERVICE_URL: "http://127.0.0.1:8001",
      AGENT_SERVICE_TOKEN: "agent-test-token-at-least-32-characters",
      AGENT_SERVICE_TIMEOUT_MS: "4500",
      VOICE_SERVICE_URL: "http://127.0.0.1:8002",
      VOICE_SERVICE_TOKEN: "voice-test-token-at-least-32-characters",
      VOICE_SERVICE_TIMEOUT_MS: "180000",
      VOICE_MAX_AUDIO_BYTES: "10485760",
      AUTH_JWT_SECRET: "gateway-jwt-test-secret-at-least-32-characters",
      AUTH_JWT_ISSUER: "aura-gateway",
      AUTH_JWT_AUDIENCE: "aura-api",
      AUTH_ACCESS_TOKEN_TTL_SECONDS: "900",
      AUTH_SESSION_TTL_SECONDS: "604800",
      DATABASE_URL: "postgresql://aura:aura@127.0.0.1:5432/aura_test",
      DATABASE_POOL_MAX: "8",
      DATABASE_CONNECT_TIMEOUT_MS: "2500",
      DATABASE_QUERY_TIMEOUT_MS: "4500",
      WEB_APP_ORIGIN: "https://aura.example.com",
    });

    expect(config).toEqual({
      approvals: { ttlSeconds: 300 },
      runtime: { environment: "production" },
      server: {
        host: "127.0.0.1",
        port: 8080,
        bodyLimit: 65_536,
        trustedProxies: ["10.20.0.0/24"],
      },
      logging: { level: "warn" },
      toolsService: {
        url: "http://127.0.0.1:4001",
        token: "gateway-test-token-at-least-32-characters",
        timeoutMs: 2500,
      },
      agentService: {
        url: "http://127.0.0.1:8001",
        token: "agent-test-token-at-least-32-characters",
        timeoutMs: 4500,
      },
      voiceService: {
        url: "http://127.0.0.1:8002",
        token: "voice-test-token-at-least-32-characters",
        timeoutMs: 180_000,
        maxAudioBytes: 10_485_760,
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
      browser: {
        origin: "https://aura.example.com",
        secureCookies: true,
        developmentSessionEnabled: false,
      },
      googleOidc: { enabled: false },
      googleCalendar: { enabled: false },
      googleGmail: { enabled: false },
      googleContacts: { enabled: false },
      memoryEmbeddings: { enabled: false },
      database: {
        url: "postgresql://aura:aura@127.0.0.1:5432/aura_test",
        poolMax: 8,
        connectTimeoutMs: 2500,
        queryTimeoutMs: 4500,
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("fails closed for malformed enabled memory embedding configuration", () => {
    const base = {
      TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
      AGENT_SERVICE_TOKEN: "agent-test-token-at-least-32-characters",
      VOICE_SERVICE_TOKEN: "voice-test-token-at-least-32-characters",
      AUTH_JWT_SECRET: "gateway-jwt-test-secret-at-least-32-characters",
      DATABASE_URL: "postgresql://aura:aura@127.0.0.1:5432/aura_test",
      MEMORY_EMBEDDINGS_ENABLED: "true",
    };
    expect(() => loadConfig(base)).toThrow(/MEMORY_EMBEDDING_BASE_URL/);
    expect(() =>
      loadConfig({
        ...base,
        MEMORY_EMBEDDING_BASE_URL: "http://127.0.0.1:8081",
        MEMORY_EMBEDDING_MODEL: "test",
        MEMORY_EMBEDDING_DIMENSIONS: "3",
      }),
    ).toThrow(/384 dimensions/);
  });

  it("rejects an invalid port", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "development",
        GATEWAY_HOST: "0.0.0.0",
        GATEWAY_PORT: "70000",
        LOG_LEVEL: "info",
        TOOLS_SERVICE_URL: "http://localhost:4001",
        TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
        TOOLS_SERVICE_TIMEOUT_MS: "3000",
      }),
    ).toThrow(ConfigurationError);
  });

  it("rejects an invalid runtime environment", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "staging",
        GATEWAY_HOST: "0.0.0.0",
        GATEWAY_PORT: "4000",
        LOG_LEVEL: "info",
        TOOLS_SERVICE_URL: "http://localhost:4001",
        TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
        TOOLS_SERVICE_TIMEOUT_MS: "3000",
      }),
    ).toThrow(/NODE_ENV/);
  });

  it("rejects missing required configuration when parsing an explicit environment", () => {
    expect(() => parseEnvironment({})).toThrow(/GATEWAY_HOST/);
  });

  it("requires a strong Tool Service token", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "development",
        GATEWAY_HOST: "0.0.0.0",
        GATEWAY_PORT: "4000",
        LOG_LEVEL: "info",
        TOOLS_SERVICE_URL: "http://localhost:4001",
        TOOLS_SERVICE_TOKEN: "short",
        TOOLS_SERVICE_TIMEOUT_MS: "3000",
      }),
    ).toThrow(/TOOLS_SERVICE_TOKEN/);
  });

  it("requires Google OIDC and a 32-byte encryption key for Calendar", () => {
    expect(() =>
      loadConfig({
        TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
        AGENT_SERVICE_TOKEN: "agent-test-token-at-least-32-characters",
        VOICE_SERVICE_TOKEN: "voice-test-token-at-least-32-characters",
        AUTH_JWT_SECRET: "gateway-jwt-test-secret-at-least-32-characters",
        DATABASE_URL: "postgresql://aura:aura@127.0.0.1:5432/aura_test",
        GOOGLE_CALENDAR_ENABLED: "true",
      }),
    ).toThrow(/Google Calendar requires Google OIDC/);
  });

  it("requires Google OIDC and provider encryption for Gmail", () => {
    expect(() =>
      loadConfig({
        TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
        AGENT_SERVICE_TOKEN: "agent-test-token-at-least-32-characters",
        VOICE_SERVICE_TOKEN: "voice-test-token-at-least-32-characters",
        AUTH_JWT_SECRET: "gateway-jwt-test-secret-at-least-32-characters",
        DATABASE_URL: "postgresql://aura:aura@127.0.0.1:5432/aura_test",
        GOOGLE_GMAIL_ENABLED: "true",
      }),
    ).toThrow(/Google Gmail requires Google OIDC/);
  });
  it("requires Google OIDC and provider encryption for Contacts", () => {
    expect(() =>
      loadConfig({
        TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
        AGENT_SERVICE_TOKEN: "agent-test-token-at-least-32-characters",
        VOICE_SERVICE_TOKEN: "voice-test-token-at-least-32-characters",
        AUTH_JWT_SECRET: "gateway-jwt-test-secret-at-least-32-characters",
        DATABASE_URL: "postgresql://aura:aura@127.0.0.1:5432/aura_test",
        GOOGLE_CONTACTS_ENABLED: "true",
      }),
    ).toThrow(/Google Contacts requires Google OIDC/);
  });

  it("requires a strong Agent Service token", () => {
    expect(() =>
      loadConfig({
        TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
        AGENT_SERVICE_TOKEN: "short",
        VOICE_SERVICE_TOKEN: "voice-test-token-at-least-32-characters",
      }),
    ).toThrow(/AGENT_SERVICE_TOKEN/);
  });

  it("requires a strong JWT secret and bounded access-token TTL", () => {
    expect(() =>
      loadConfig({
        TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
        AGENT_SERVICE_TOKEN: "agent-test-token-at-least-32-characters",
        VOICE_SERVICE_TOKEN: "voice-test-token-at-least-32-characters",
        AUTH_JWT_SECRET: "short",
      }),
    ).toThrow(/AUTH_JWT_SECRET/);
    expect(() =>
      loadConfig({
        TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
        AGENT_SERVICE_TOKEN: "agent-test-token-at-least-32-characters",
        VOICE_SERVICE_TOKEN: "voice-test-token-at-least-32-characters",
        AUTH_JWT_SECRET: "gateway-jwt-test-secret-at-least-32-characters",
        AUTH_ACCESS_TOKEN_TTL_SECONDS: "86400",
      }),
    ).toThrow(/AUTH_ACCESS_TOKEN_TTL_SECONDS/);
  });

  it("requires a complete Google OIDC configuration only when enabled", () => {
    expect(() =>
      loadConfig({
        TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
        AGENT_SERVICE_TOKEN: "agent-test-token-at-least-32-characters",
        VOICE_SERVICE_TOKEN: "voice-test-token-at-least-32-characters",
        AUTH_JWT_SECRET: "gateway-jwt-test-secret-at-least-32-characters",
        DATABASE_URL: "postgresql://aura:aura@127.0.0.1:5432/aura_test",
        GOOGLE_OIDC_ENABLED: "true",
      }),
    ).toThrow(/GOOGLE_OIDC_CLIENT_ID/);

    const config = loadConfig({
      TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
      AGENT_SERVICE_TOKEN: "agent-test-token-at-least-32-characters",
      VOICE_SERVICE_TOKEN: "voice-test-token-at-least-32-characters",
      AUTH_JWT_SECRET: "gateway-jwt-test-secret-at-least-32-characters",
      DATABASE_URL: "postgresql://aura:aura@127.0.0.1:5432/aura_test",
      GOOGLE_OIDC_ENABLED: "true",
      GOOGLE_OIDC_CLIENT_ID: "client.apps.googleusercontent.com",
      GOOGLE_OIDC_CLIENT_SECRET: "provider-secret",
      GOOGLE_OIDC_REDIRECT_URI:
        "http://localhost:4000/api/v1/auth/google/callback",
    });
    expect(config.googleOidc).toMatchObject({
      enabled: true,
      clientId: "client.apps.googleusercontent.com",
      transactionTtlSeconds: 600,
    });
  });

  it("requires HTTPS browser origins and explicit trusted proxies in production", () => {
    const base = {
      NODE_ENV: "production",
      TOOLS_SERVICE_TOKEN: "gateway-test-token-at-least-32-characters",
      AGENT_SERVICE_TOKEN: "agent-test-token-at-least-32-characters",
      VOICE_SERVICE_TOKEN: "voice-test-token-at-least-32-characters",
      AUTH_JWT_SECRET: "gateway-jwt-test-secret-at-least-32-characters",
      DATABASE_URL: "postgresql://aura:aura@127.0.0.1:5432/aura_test",
    };
    expect(() => loadConfig(base)).toThrow(/WEB_APP_ORIGIN/);
    expect(() =>
      loadConfig({
        ...base,
        WEB_APP_ORIGIN: "https://aura.example.com",
        GATEWAY_TRUST_PROXY: "*",
      }),
    ).toThrow(/GATEWAY_TRUST_PROXY/);
  });
});
