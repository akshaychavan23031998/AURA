import hmac
import logging
import re
import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Header, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from aura_voice.audio import InvalidAudioError, NoSpeechDetectedError, validate_wav
from aura_voice.config import Settings, get_settings
from aura_voice.contracts import SynthesisRequest
from aura_voice.locale import UnsupportedLocaleError, normalize_locale, normalize_text
from aura_voice.logging import configure_logging
from aura_voice.speech import (
    SpeechRuntimeError,
    SpeechSynthesizer,
    SpeechTranscriber,
)
from aura_voice.tts import (
    InvalidSynthesisOutputError,
    TtsFailedError,
    TtsTimeoutError,
    TtsUnavailableError,
)

REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
logger = logging.getLogger("aura.voice")


def create_app(
    settings: Settings, transcriber: SpeechTranscriber, synthesizer: SpeechSynthesizer
) -> FastAPI:
    configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            await transcriber.initialize()
            await synthesizer.initialize()
            app.state.ready = True
            logger.info("Voice Service initialized")
            yield
        finally:
            app.state.ready = False
            logger.info("Voice Service stopped")

    app = FastAPI(
        title="AURA Voice Service", docs_url=None, redoc_url=None, lifespan=lifespan
    )
    app.state.ready = False

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        supplied = request.headers.get("x-request-id", "")
        request.state.request_id = (
            supplied if REQUEST_ID_PATTERN.fullmatch(supplied) else str(uuid4())
        )
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["x-request-id"] = request.state.request_id
        logger.info(
            "HTTP request completed",
            extra={
                "requestId": request.state.request_id,
                "method": request.method,
                "path": request.url.path,
                "statusCode": response.status_code,
                "durationMs": round((time.perf_counter() - started) * 1000, 3),
            },
        )
        return response

    async def authenticate(
        service_id: Annotated[str | None, Header(alias="x-aura-service-id")] = None,
        token: Annotated[str | None, Header(alias="x-aura-service-token")] = None,
    ) -> None:
        if not (
            service_id is not None
            and token is not None
            and hmac.compare_digest(service_id, settings.aura_allowed_service_id)
            and hmac.compare_digest(token, settings.aura_internal_service_token)
        ):
            raise InternalAuthenticationError

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "voice"}

    @app.get("/ready")
    async def ready(request: Request) -> dict[str, str]:
        if not request.app.state.ready:
            raise ServiceNotReadyError
        return {"status": "ready", "service": "voice"}

    @app.post("/v1/stt", dependencies=[Depends(authenticate)])
    async def stt(
        request: Request, audio: Annotated[UploadFile, File()]
    ) -> dict[str, object]:
        if audio.content_type not in {"audio/wav", "audio/x-wav", "audio/wave"}:
            raise InvalidAudioError
        data = await audio.read(settings.voice_max_audio_bytes + 1)
        validated = validate_wav(
            data, settings.voice_max_audio_bytes, settings.voice_max_audio_seconds
        )
        hint = request.headers.get("x-aura-locale-hint")
        started = time.perf_counter()
        result = await transcriber.transcribe(validated, hint)
        logger.info(
            "Speech transcription completed",
            extra={
                "requestId": request.state.request_id,
                "audioBytes": len(data),
                "audioDurationMs": validated.duration_ms,
                "detectedLanguage": result.detected_language,
                "durationMs": round((time.perf_counter() - started) * 1000, 3),
                "operation": "stt",
            },
        )
        return result.model_dump(by_alias=True)

    @app.post(
        "/v1/tts",
        dependencies=[Depends(authenticate)],
        responses={200: {"content": {"audio/wav": {}}}},
    )
    async def tts(payload: SynthesisRequest, request: Request) -> Response:
        if len(payload.text) > settings.voice_max_tts_characters:
            raise InvalidSynthesisRequestError
        started = time.perf_counter()
        text = normalize_text(payload.text)
        selected = normalize_locale(payload.locale, text)
        audio = await synthesizer.synthesize(text, selected)
        logger.info(
            "Speech synthesis completed",
            extra={
                "requestId": request.state.request_id,
                "durationMs": round((time.perf_counter() - started) * 1000, 3),
                "audioBytes": len(audio),
                "operation": "tts",
            },
        )
        return Response(audio, media_type="audio/wav")

    register_error_handlers(app)
    return app


class InternalAuthenticationError(Exception):
    pass


class ServiceNotReadyError(Exception):
    pass


class InvalidSynthesisRequestError(Exception):
    pass


def error_response(
    status: int, code: str, message: str, request: Request
) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={
            "error": {
                "code": code,
                "message": message,
                "requestId": getattr(request.state, "request_id", str(uuid4())),
            }
        },
    )


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(InternalAuthenticationError)
    async def auth_error(
        request: Request, _: InternalAuthenticationError
    ) -> JSONResponse:
        return error_response(
            401,
            "INTERNAL_SERVICE_UNAUTHORIZED",
            "Internal service authentication failed",
            request,
        )

    async def invalid_audio(request: Request, _: Exception) -> JSONResponse:
        return error_response(
            400,
            "VOICE_INVALID_AUDIO",
            "Audio must be a bounded 16 kHz mono PCM WAV",
            request,
        )

    @app.exception_handler(NoSpeechDetectedError)
    async def no_speech(request: Request, _: NoSpeechDetectedError) -> JSONResponse:
        return error_response(
            422, "VOICE_NO_SPEECH_DETECTED", "No speech was detected", request
        )

    @app.exception_handler(UnsupportedLocaleError)
    async def unsupported_language(
        request: Request, _: UnsupportedLocaleError
    ) -> JSONResponse:
        return error_response(
            422,
            "VOICE_LANGUAGE_UNSUPPORTED",
            "The configured voice does not support this language",
            request,
        )

    @app.exception_handler(InvalidSynthesisRequestError)
    async def invalid_tts(
        request: Request, _: InvalidSynthesisRequestError
    ) -> JSONResponse:
        return error_response(
            400, "VALIDATION_ERROR", "Request validation failed", request
        )

    async def runtime_error(request: Request, error: Exception) -> JSONResponse:
        logger.exception("Speech runtime failed", exc_info=error)
        code = (
            "SERVICE_NOT_READY"
            if isinstance(error, ServiceNotReadyError)
            else "VOICE_PROCESSING_FAILED"
        )
        return error_response(
            503 if isinstance(error, ServiceNotReadyError) else 500,
            code,
            "Voice Service is not ready"
            if isinstance(error, ServiceNotReadyError)
            else "Speech processing failed",
            request,
        )

    app.add_exception_handler(InvalidAudioError, invalid_audio)
    app.add_exception_handler(RequestValidationError, invalid_audio)
    app.add_exception_handler(SpeechRuntimeError, runtime_error)
    app.add_exception_handler(ServiceNotReadyError, runtime_error)

    async def tts_error(request: Request, error: Exception) -> JSONResponse:
        mapping: tuple[int, str, str]
        if isinstance(error, TtsTimeoutError):
            mapping = (504, "VOICE_TTS_TIMEOUT", "Speech synthesis timed out")
        elif isinstance(error, TtsUnavailableError):
            mapping = (503, "VOICE_TTS_UNAVAILABLE", "Speech synthesis is unavailable")
        elif isinstance(error, InvalidSynthesisOutputError):
            mapping = (
                502,
                "VOICE_INVALID_SYNTHESIS_OUTPUT",
                "Speech synthesis returned invalid audio",
            )
        else:
            mapping = (502, "VOICE_TTS_FAILED", "Speech synthesis failed")
        logger.exception("Speech synthesis failed", exc_info=error)
        return error_response(mapping[0], mapping[1], mapping[2], request)

    for error_type in (
        TtsTimeoutError,
        TtsUnavailableError,
        InvalidSynthesisOutputError,
        TtsFailedError,
    ):
        app.add_exception_handler(error_type, tts_error)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, error: Exception) -> JSONResponse:
        logger.exception("Unexpected Voice Service error", exc_info=error)
        return error_response(
            500,
            "VOICE_PROCESSING_FAILED",
            "Speech processing failed",
            request,
        )


def create_runtime_app() -> FastAPI:
    import asyncio

    from aura_voice.speech import LocalSpeechTranscriber
    from aura_voice.tts import PiperEngine, VoiceCapability, VoiceRegistry

    settings = get_settings()
    semaphore = asyncio.Semaphore(settings.voice_inference_concurrency)
    return create_app(
        settings,
        LocalSpeechTranscriber(
            settings.voice_stt_model,
            settings.voice_stt_device,
            settings.voice_stt_compute_type,
            semaphore,
        ),
        VoiceRegistry(
            {
                "en": PiperEngine(
                    settings.tts_model_root / f"{settings.tts_voice_en}.onnx", semaphore
                ),
                "hi": PiperEngine(
                    settings.tts_model_root / f"{settings.tts_voice_hi}.onnx", semaphore
                ),
                "te": PiperEngine(
                    settings.tts_model_root / f"{settings.tts_voice_te}.onnx", semaphore
                ),
            },
            (
                VoiceCapability(
                    "en",
                    ("en", "en-IN", "en-US"),
                    settings.tts_voice_en,
                    22050,
                    "supported",
                ),
                VoiceCapability(
                    "hi", ("hi", "hi-IN"), settings.tts_voice_hi, 22050, "supported"
                ),
                VoiceCapability(
                    "te", ("te", "te-IN"), settings.tts_voice_te, 22050, "experimental"
                ),
                VoiceCapability("kn", ("kn", "kn-IN"), None, None, "unsupported"),
            ),
            settings.tts_timeout_seconds,
            settings.tts_max_output_bytes,
        ),
    )
