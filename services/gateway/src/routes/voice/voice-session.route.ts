import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { WebSocket } from "ws";
import { deriveAuthorizationContext } from "../../auth/authorization-context.js";
import { requirePrincipal } from "../../auth/auth-plugin.js";
import type { GatewayConfig } from "../../config/index.js";
import type { VoiceTurnService } from "../../orchestration/voice-turn-service.js";
import { clientEventSchema, VOICE_PROTOCOL } from "../../voice/protocol.js";
import { VoiceSessionCoordinator } from "../../voice/session-coordinator.js";
import type { ApprovalRealtimeRegistry } from "../../approvals/approval-realtime-registry.js";

const AUTH_PROTOCOL_PREFIX = "aura.jwt.";

export function extractWebSocketBearerProtocol(
  header: string | string[] | undefined,
): string | undefined {
  if (typeof header !== "string" || header.length > 8_192) return undefined;
  const credentials = header
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(AUTH_PROTOCOL_PREFIX));
  if (credentials.length !== 1) return undefined;
  const token = credentials[0]?.slice(AUTH_PROTOCOL_PREFIX.length);
  return token === undefined ? undefined : `Bearer ${token}`;
}

export function registerVoiceSessionRoute(
  app: FastifyInstance,
  turns: VoiceTurnService,
  authenticate: preHandlerHookHandler,
  config: GatewayConfig,
  realtimeApprovals?: ApprovalRealtimeRegistry,
): void {
  const authenticateUpgrade: preHandlerHookHandler = function (
    request,
    reply,
    done,
  ) {
    if (request.headers.authorization === undefined) {
      request.headers.authorization = extractWebSocketBearerProtocol(
        request.headers["sec-websocket-protocol"],
      );
    }
    authenticate.call(this, request, reply, done);
  };
  app.get(
    "/api/v1/voice/session",
    { websocket: true, preHandler: authenticateUpgrade },
    (socket: WebSocket, request) => {
      const sendError = () =>
        socket.send(
          JSON.stringify({
            protocol: VOICE_PROTOCOL,
            type: "error",
            requestId: request.id,
            sessionId: session.sessionId,
            payload: { code: "VOICE_INVALID_EVENT" },
          }),
        );
      const session = new VoiceSessionCoordinator(
        request.id,
        deriveAuthorizationContext(requirePrincipal(request)),
        turns,
        {
          event: (event) => socket.send(JSON.stringify(event)),
          audio: (chunk) => socket.send(chunk),
          close: () => socket.close(),
        },
        config.voiceStream,
        undefined,
        realtimeApprovals,
      );
      let alive = true;
      let idleTimer: NodeJS.Timeout;
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          socket.send(
            JSON.stringify({
              protocol: VOICE_PROTOCOL,
              type: "error",
              requestId: request.id,
              sessionId: session.sessionId,
              payload: { code: "VOICE_SESSION_TIMEOUT" },
            }),
          );
          session.close();
          socket.close(1008, "Session idle timeout");
        }, config.voiceStream.idleTimeoutMs);
        idleTimer.unref();
      };
      const heartbeat = setInterval(() => {
        if (!alive) {
          session.close();
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, 30_000);
      heartbeat.unref();
      socket.on("pong", () => {
        alive = true;
      });
      socket.on("message", (data, binary) => {
        resetIdleTimer();
        if (binary) {
          session.acceptAudio(Buffer.from(data as ArrayBuffer));
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.from(data as ArrayBuffer).toString("utf8"));
        } catch {
          sendError();
          return;
        }
        const parsed = clientEventSchema.safeParse(body);
        if (!parsed.success) {
          sendError();
          return;
        }
        if (parsed.data.type === "session.start")
          session.start(parsed.data.locale);
        else {
          session.close();
          socket.close(1000);
        }
      });
      socket.on("close", () => {
        clearInterval(heartbeat);
        clearTimeout(idleTimer);
        session.close();
      });
      resetIdleTimer();
    },
  );
}
