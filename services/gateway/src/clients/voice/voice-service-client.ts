import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { GatewayConfig } from "../../config/index.js";
import { AppError } from "../../errors/app-error.js";

export const VOICE_SERVICE_TOKEN_HEADER = "x-aura-service-token";
const MAX_AUDIO_RESPONSE_BYTES = 12 * 1024 * 1024;
const sttSchema = z
  .object({
    text: z.string().trim().min(1).max(8192),
    detectedLanguage: z.string().min(1).max(35),
    durationMs: z.number().nonnegative(),
  })
  .strict();
export type Transcription = z.infer<typeof sttSchema>;
export interface VoiceServiceClient {
  transcribe(
    audio: Buffer,
    mimeType: string,
    requestId: string,
    locale?: string,
  ): Promise<Transcription>;
  synthesize(
    text: string,
    language: string,
    requestId: string,
  ): Promise<Buffer>;
}
export interface VoiceClientLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
}

export function createVoiceServiceClient(
  config: GatewayConfig,
  fetchImplementation: typeof fetch = fetch,
  logger?: VoiceClientLogger,
): VoiceServiceClient {
  const headers = (requestId: string) => ({
    "x-aura-service-id": "gateway",
    [VOICE_SERVICE_TOKEN_HEADER]: config.voiceService.token,
    "x-request-id": requestId,
  });
  return {
    async transcribe(audio, mimeType, requestId, locale) {
      const startedAt = performance.now();
      try {
        const form = new FormData();
        form.append(
          "audio",
          new Blob([Uint8Array.from(audio)], { type: mimeType }),
          "audio.wav",
        );
        const response = await fetchImplementation(
          `${config.voiceService.url}/v1/stt`,
          {
            method: "POST",
            headers: {
              ...headers(requestId),
              ...(locale === undefined ? {} : { "x-aura-locale-hint": locale }),
            },
            body: form,
            signal: AbortSignal.timeout(config.voiceService.timeoutMs),
          },
        );
        if (!response.ok)
          throw await upstreamError(
            response,
            "VOICE_TRANSCRIPTION_FAILED",
            "Speech transcription failed",
          );
        const parsed = sttSchema.safeParse(await response.json());
        if (
          !parsed.success ||
          response.headers.get("x-request-id") !== requestId
        )
          throw protocolError();
        logger?.info(
          {
            upstream: "voice",
            operation: "stt",
            requestId,
            duration: performance.now() - startedAt,
          },
          "Voice STT call completed",
        );
        return parsed.data;
      } catch (error) {
        throw translate(
          error,
          "VOICE_TRANSCRIPTION_FAILED",
          "Speech transcription failed",
          logger,
          requestId,
          "stt",
          startedAt,
        );
      }
    },
    async synthesize(text, language, requestId) {
      const startedAt = performance.now();
      try {
        const response = await fetchImplementation(
          `${config.voiceService.url}/v1/tts`,
          {
            method: "POST",
            headers: {
              ...headers(requestId),
              "content-type": "application/json",
            },
            body: JSON.stringify({ text, language }),
            signal: AbortSignal.timeout(config.voiceService.timeoutMs),
          },
        );
        if (!response.ok)
          throw await upstreamError(
            response,
            "VOICE_SYNTHESIS_FAILED",
            "The action may have completed, but speech synthesis failed",
          );
        const length = Number(response.headers.get("content-length") ?? "0");
        if (
          !(response.headers.get("content-type") ?? "")
            .toLowerCase()
            .includes("audio/wav") ||
          length > MAX_AUDIO_RESPONSE_BYTES
        )
          throw protocolError();
        const audio = Buffer.from(await response.arrayBuffer());
        if (audio.length === 0 || audio.length > MAX_AUDIO_RESPONSE_BYTES)
          throw protocolError();
        logger?.info(
          {
            upstream: "voice",
            operation: "tts",
            requestId,
            audioBytes: audio.length,
            duration: performance.now() - startedAt,
          },
          "Voice TTS call completed",
        );
        return audio;
      } catch (error) {
        throw translate(
          error,
          "VOICE_SYNTHESIS_FAILED",
          "The action may have completed, but speech synthesis failed",
          logger,
          requestId,
          "tts",
          startedAt,
        );
      }
    },
  };
}
async function upstreamError(
  response: Response,
  fallbackCode: string,
  fallbackMessage: string,
): Promise<AppError> {
  let code = fallbackCode;
  try {
    const body = z
      .object({ error: z.object({ code: z.string() }) })
      .safeParse(await response.json());
    if (
      body.success &&
      [
        "VOICE_INVALID_AUDIO",
        "VOICE_NO_SPEECH_DETECTED",
        "VOICE_LANGUAGE_UNSUPPORTED",
      ].includes(body.data.error.code)
    )
      code = body.data.error.code;
  } catch {
    // Malformed upstream errors are intentionally reduced to the safe fallback.
  }
  const status =
    code === "VOICE_INVALID_AUDIO"
      ? 400
      : code === "VOICE_NO_SPEECH_DETECTED" ||
          code === "VOICE_LANGUAGE_UNSUPPORTED"
        ? 422
        : 502;
  return new AppError({
    code,
    httpStatus: status,
    message: code === fallbackCode ? fallbackMessage : safeMessage(code),
  });
}
function safeMessage(code: string): string {
  return (
    (
      {
        VOICE_INVALID_AUDIO: "Audio must be a bounded 16 kHz mono PCM WAV",
        VOICE_NO_SPEECH_DETECTED: "No speech was detected",
        VOICE_LANGUAGE_UNSUPPORTED:
          "The configured voice does not support this language",
      } as Record<string, string>
    )[code] ?? "Voice processing failed"
  );
}
function protocolError(): AppError {
  return new AppError({
    code: "UPSTREAM_PROTOCOL_ERROR",
    httpStatus: 502,
    message: "Voice Service returned an invalid response",
  });
}
function translate(
  error: unknown,
  code: string,
  message: string,
  logger: VoiceClientLogger | undefined,
  requestId: string,
  operation: string,
  startedAt: number,
): AppError {
  logger?.warn(
    {
      upstream: "voice",
      operation,
      requestId,
      duration: performance.now() - startedAt,
    },
    "Voice Service call failed",
  );
  if (error instanceof AppError) return error;
  if (error instanceof DOMException && error.name === "TimeoutError")
    return new AppError({
      code: "UPSTREAM_SERVICE_TIMEOUT",
      httpStatus: 504,
      message: "Voice Service timed out",
      cause: error,
    });
  return new AppError({ code, httpStatus: 502, message, cause: error });
}
