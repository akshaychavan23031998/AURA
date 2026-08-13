import asyncio
import io
from collections.abc import Iterator
from typing import Protocol, cast

from aura_voice.audio import NoSpeechDetectedError, ValidatedAudio
from aura_voice.contracts import TranscriptionResult
from aura_voice.locale import SynthesisLocale


class SpeechRuntimeError(Exception):
    pass


class SpeechTranscriber(Protocol):
    async def initialize(self) -> None: ...
    async def transcribe(
        self, audio: ValidatedAudio, language_hint: str | None
    ) -> TranscriptionResult: ...


class SpeechSynthesizer(Protocol):
    async def initialize(self) -> None: ...
    async def synthesize(self, text: str, locale: SynthesisLocale) -> bytes: ...


class _Segment(Protocol):
    text: str


class LocalSpeechTranscriber:
    def __init__(
        self,
        model_name: str,
        device: str,
        compute_type: str,
        semaphore: asyncio.Semaphore,
    ) -> None:
        self._model_name = model_name
        self._device = device
        self._compute_type = compute_type
        self._semaphore = semaphore
        self._model: object | None = None

    async def initialize(self) -> None:
        try:
            from faster_whisper import WhisperModel

            self._model = await asyncio.to_thread(
                WhisperModel,
                self._model_name,
                device=self._device,
                compute_type=self._compute_type,
            )
        except Exception as error:
            raise SpeechRuntimeError("STT model could not be initialized") from error

    async def transcribe(
        self, audio: ValidatedAudio, language_hint: str | None
    ) -> TranscriptionResult:
        if self._model is None:
            raise SpeechRuntimeError("STT model is not initialized")
        async with self._semaphore:
            return await asyncio.to_thread(self._transcribe_sync, audio, language_hint)

    def _transcribe_sync(
        self, audio: ValidatedAudio, language_hint: str | None
    ) -> TranscriptionResult:
        model = cast(object, self._model)
        transcribe = getattr(model, "transcribe")  # noqa: B009 - optional runtime is dynamically imported
        language = language_hint.split("-")[0] if language_hint else None
        segments, info = transcribe(
            io.BytesIO(audio.wav_bytes), language=language, vad_filter=True, beam_size=1
        )
        text = " ".join(
            str(segment.text).strip() for segment in cast(Iterator[_Segment], segments)
        ).strip()
        if not text:
            raise NoSpeechDetectedError
        detected = str(getattr(info, "language", language or "unknown"))
        return TranscriptionResult(
            text=text, detectedLanguage=detected, durationMs=audio.duration_ms
        )
