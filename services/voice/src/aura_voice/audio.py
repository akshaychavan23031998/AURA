import io
import wave
from dataclasses import dataclass


class InvalidAudioError(Exception):
    pass


class NoSpeechDetectedError(Exception):
    pass


@dataclass(frozen=True)
class ValidatedAudio:
    wav_bytes: bytes
    duration_ms: float
    sample_rate: int


def validate_wav(data: bytes, max_bytes: int, max_seconds: float) -> ValidatedAudio:
    if not data or len(data) > max_bytes:
        raise InvalidAudioError
    try:
        with wave.open(io.BytesIO(data), "rb") as reader:
            channels = reader.getnchannels()
            sample_width = reader.getsampwidth()
            sample_rate = reader.getframerate()
            frames = reader.getnframes()
            compression = reader.getcomptype()
    except (EOFError, wave.Error):
        raise InvalidAudioError from None
    if channels != 1 or sample_width != 2 or compression != "NONE":
        raise InvalidAudioError
    duration = frames / sample_rate if sample_rate else 0
    if sample_rate != 16_000 or duration <= 0 or duration > max_seconds:
        raise InvalidAudioError
    return ValidatedAudio(data, round(duration * 1000, 3), sample_rate)
