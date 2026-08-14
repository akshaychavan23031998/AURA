import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";

import type { GatewayConfig } from "../config/index.js";
import {
  createAgentServiceClient,
  INTERNAL_SERVICE_TOKEN_HEADER,
  type AgentServiceClient,
} from "../clients/agent/agent-service-client.js";
import {
  createToolServiceClient,
  TOOL_SERVICE_TOKEN_HEADER,
  type ToolServiceClient,
} from "../clients/tools/tool-service-client.js";
import { registerErrorHandling } from "../errors/error-handler.js";
import {
  registerRequestContext,
  resolveRequestId,
} from "../plugins/request-context.js";
import { registerSecurity } from "../plugins/security.js";
import { registerRoutes } from "../routes/index.js";
import { AgentToolOrchestrator } from "../orchestration/agent-tool-orchestrator.js";
import { registerAuthentication } from "../auth/auth-plugin.js";
import {
  createAccessTokenVerifier,
  type AccessTokenVerifier,
} from "../auth/token-verifier.js";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { IdentityRepository } from "../identity/repositories.js";
import {
  SessionService,
  type SessionManager,
} from "../identity/session-service.js";
import {
  createVoiceServiceClient,
  VOICE_SERVICE_TOKEN_HEADER,
  type VoiceServiceClient,
} from "../clients/voice/voice-service-client.js";
import { VoiceTurnService } from "../orchestration/voice-turn-service.js";
import {
  OpenIdClientGoogleProvider,
  type GoogleOidcProvider,
} from "../identity/google-oidc-client.js";
import type { ExternalIdentityResolver } from "../routes/auth/google-oidc.route.js";

export interface CreateAppOptions {
  readonly config: GatewayConfig;
  readonly logger?: FastifyServerOptions["logger"];
  readonly toolClient?: ToolServiceClient;
  readonly agentClient?: AgentServiceClient;
  readonly tokenVerifier?: AccessTokenVerifier;
  readonly database?: DatabaseClient;
  readonly sessionService?: SessionManager;
  readonly voiceClient?: VoiceServiceClient;
  readonly googleOidcProvider?: GoogleOidcProvider;
  readonly externalIdentityResolver?: ExternalIdentityResolver;
}

export async function createApp(
  options: CreateAppOptions,
): Promise<FastifyInstance> {
  const serverOptions: FastifyServerOptions = {
    logger:
      options.logger ??
      ({
        level: options.config.logging.level,
        base: {
          service: "gateway",
          environment: options.config.runtime.environment,
        },
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.headers.sec-websocket-protocol",
            `req.headers.${TOOL_SERVICE_TOKEN_HEADER}`,
            `req.headers.${INTERNAL_SERVICE_TOKEN_HEADER}`,
            `req.headers.${VOICE_SERVICE_TOKEN_HEADER}`,
          ],
          censor: "[REDACTED]",
        },
        serializers: { req: serializeRequest },
      } satisfies FastifyServerOptions["logger"]),
    genReqId: resolveRequestId,
    bodyLimit: options.config.server.bodyLimit,
    trustProxy: [...options.config.server.trustedProxies],
  };
  const app = Fastify(serverOptions);
  const database = options.database ?? createDatabaseClient(options.config);
  const identityRepository = new IdentityRepository(database);
  const sessions =
    options.sessionService ??
    new SessionService(identityRepository, options.config.auth);
  const googleOidcProvider =
    options.googleOidcProvider ??
    (options.config.googleOidc.enabled
      ? new OpenIdClientGoogleProvider(options.config.googleOidc)
      : undefined);
  const toolClient =
    options.toolClient ??
    createToolServiceClient(options.config, fetch, app.log);
  const agentClient =
    options.agentClient ??
    createAgentServiceClient(options.config, fetch, app.log);
  const voiceClient =
    options.voiceClient ??
    createVoiceServiceClient(options.config, fetch, app.log);

  await registerSecurity(app, options.config);
  await app.register(websocket, {
    options: {
      maxPayload: options.config.voiceService.maxAudioBytes,
      handleProtocols: (protocols) =>
        protocols.has("aura.voice.v1") ? "aura.voice.v1" : false,
    },
  });
  await app.register(multipart, {
    limits: {
      files: 1,
      fields: 2,
      fileSize: options.config.voiceService.maxAudioBytes,
    },
  });
  registerRequestContext(app);
  const authenticate = registerAuthentication(
    app,
    options.tokenVerifier ??
      createAccessTokenVerifier(options.config, sessions),
  );
  registerRoutes(
    app,
    toolClient,
    agentClient,
    new AgentToolOrchestrator({
      agentClient,
      toolClient,
      logger: app.log,
    }),
    authenticate,
    sessions,
    () => database.check(),
    new VoiceTurnService(
      voiceClient,
      new AgentToolOrchestrator({ agentClient, toolClient, logger: app.log }),
      app.log,
    ),
    options.config,
    googleOidcProvider,
    options.externalIdentityResolver ?? identityRepository,
  );
  app.addHook("onClose", async () => database.close());
  registerErrorHandling(app);

  return app;
}

function serializeRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: sanitizeRequestUrl(request.url),
    remoteAddress: request.ip,
  };
}

export function sanitizeRequestUrl(url: string): string {
  return url.split("?", 1)[0] ?? "/";
}
