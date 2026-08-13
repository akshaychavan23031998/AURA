import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { deriveAuthorizationContext } from "../../auth/authorization-context.js";
import { requirePrincipal } from "../../auth/auth-plugin.js";
import { AppError } from "../../errors/app-error.js";
import type { VoiceTurnService } from "../../orchestration/voice-turn-service.js";
const AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave"]);
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
export function registerVoiceRunRoute(
  app: FastifyInstance,
  service: VoiceTurnService,
  authenticate: preHandlerHookHandler,
): void {
  app.post(
    "/api/v1/voice/run",
    { preHandler: authenticate },
    async (request) => {
      if (!request.isMultipart()) throw invalid();
      let audio: Buffer | undefined;
      let mimeType = "";
      let conversationId: string | undefined;
      let locale: string | undefined;
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (
            part.fieldname !== "audio" ||
            audio !== undefined ||
            !AUDIO_TYPES.has(part.mimetype)
          )
            throw invalid();
          mimeType = part.mimetype;
          audio = await part.toBuffer();
        } else {
          if (typeof part.value !== "string") throw invalid();
          if (
            part.fieldname === "conversationId" &&
            conversationId === undefined &&
            part.value.length <= 128
          )
            conversationId = part.value;
          else if (
            part.fieldname === "locale" &&
            locale === undefined &&
            part.value.length <= 35 &&
            LOCALE.test(part.value)
          )
            locale = part.value;
          else throw invalid();
        }
      }
      if (audio === undefined || audio.length === 0) throw invalid();
      return service.run(
        {
          audio,
          mimeType,
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(locale === undefined ? {} : { locale }),
        },
        request.id,
        deriveAuthorizationContext(requirePrincipal(request)),
      );
    },
  );
}
function invalid(): AppError {
  return new AppError({
    code: "VOICE_INVALID_AUDIO",
    httpStatus: 400,
    message: "Audio must be a bounded 16 kHz mono PCM WAV",
  });
}
