import asyncio
import io
import wave
from collections.abc import Iterator
from pathlib import Path
from typing import Protocol, cast

from aura_voice.audio import NoSpeechDetectedError, ValidatedAudio
from aura_voice.contracts import TranscriptionResult


class SpeechRuntimeError(Exception):
    pass


class UnsupportedSynthesisLanguageError(Exception):
    pass


class SpeechTranscriber(Protocol):
    async def initialize(self) -> None: ...
    async def transcribe(
        self, audio: ValidatedAudio, language_hint: str | None
    ) -> TranscriptionResult: ...


class SpeechSynthesizer(Protocol):
    async def initialize(self) -> None: ...
    async def synthesize(self, text: str, language: str) -> bytes: ...


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


class LocalTtsSynthesizer:
    def __init__(self, model_path: Path, semaphore: asyncio.Semaphore) -> None:
        self._model_path = model_path
        self._semaphore = semaphore
        self._voice: object | None = None

    async def initialize(self) -> None:
        if (
            not self._model_path.is_file()
            or not self._model_path.with_suffix(
                self._model_path.suffix + ".json"
            ).is_file()
        ):
            raise SpeechRuntimeError("TTS model files are unavailable")
        try:
            from piper import PiperVoice

            self._voice = await asyncio.to_thread(
                PiperVoice.load, str(self._model_path)
            )
        except Exception as error:
            raise SpeechRuntimeError("TTS model could not be initialized") from error

    async def synthesize(self, text: str, language: str) -> bytes:
        if self._voice is None:
            raise SpeechRuntimeError("TTS model is not initialized")
        if language.split("-")[0].lower() != "en":
            raise UnsupportedSynthesisLanguageError
        async with self._semaphore:
            return await asyncio.to_thread(self._synthesize_sync, text)

    def _synthesize_sync(self, text: str) -> bytes:
        output = io.BytesIO()
        with wave.open(output, "wb") as wav_file:
            getattr(self._voice, "synthesize_wav")(text, wav_file)  # noqa: B009 - optional runtime is dynamically imported
        return output.getvalue()
