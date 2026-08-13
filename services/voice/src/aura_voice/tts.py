import asyncio
import io
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from aura_voice.locale import CanonicalLanguage, SynthesisLocale


class TtsUnavailableError(Exception):
    pass


class TtsTimeoutError(Exception):
    pass


class TtsFailedError(Exception):
    pass


class InvalidSynthesisOutputError(Exception):
    pass


class TtsEngine(Protocol):
    async def initialize(self) -> None: ...
    async def synthesize(self, text: str) -> bytes: ...


@dataclass(frozen=True)
class VoiceCapability:
    language: CanonicalLanguage
    locales: tuple[str, ...]
    voice_id: str | None
    sample_rate: int | None
    status: str


class PiperEngine:
    def __init__(self, model_path: Path, semaphore: asyncio.Semaphore) -> None:
        self._path = model_path
        self._semaphore = semaphore
        self._voice: object | None = None

    async def initialize(self) -> None:
        if (
            not self._path.is_file()
            or not self._path.with_suffix(".onnx.json").is_file()
        ):
            raise TtsUnavailableError
        try:
            from piper import PiperVoice

            self._voice = await asyncio.to_thread(PiperVoice.load, str(self._path))
        except Exception as error:
            raise TtsUnavailableError from error

    async def synthesize(self, text: str) -> bytes:
        if self._voice is None:
            raise TtsUnavailableError
        async with self._semaphore:
            try:
                return await asyncio.to_thread(self._synthesize, text)
            except Exception as error:
                raise TtsFailedError from error

    def _synthesize(self, text: str) -> bytes:
        output = io.BytesIO()
        with wave.open(output, "wb") as wav_file:
            getattr(self._voice, "synthesize_wav")(text, wav_file)  # noqa: B009
        return output.getvalue()


class VoiceRegistry:
    def __init__(
        self,
        engines: dict[CanonicalLanguage, TtsEngine],
        capabilities: tuple[VoiceCapability, ...],
        timeout_seconds: float,
        max_output_bytes: int,
    ) -> None:
        self._engines = engines
        self.capabilities = capabilities
        self._timeout = timeout_seconds
        self._max = max_output_bytes

    async def initialize(self) -> None:
        await asyncio.gather(
            *(engine.initialize() for engine in self._engines.values())
        )

    async def synthesize(self, text: str, locale: SynthesisLocale) -> bytes:
        engine = self._engines.get(locale.language)
        if engine is None:
            raise TtsUnavailableError
        try:
            audio = await asyncio.wait_for(engine.synthesize(text), self._timeout)
        except TimeoutError as error:
            raise TtsTimeoutError from error
        validate_wav_output(audio, self._max)
        return audio


def validate_wav_output(data: bytes, max_bytes: int) -> None:
    if not data or len(data) > max_bytes:
        raise InvalidSynthesisOutputError
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            valid = (
                wav.getnchannels() == 1
                and wav.getsampwidth() == 2
                and 8_000 <= wav.getframerate() <= 48_000
                and wav.getnframes() > 0
                and wav.getcomptype() == "NONE"
            )
    except (EOFError, wave.Error):
        raise InvalidSynthesisOutputError from None
    if not valid:
        raise InvalidSynthesisOutputError
