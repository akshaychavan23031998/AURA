import asyncio
import io
import wave

import pytest

from aura_voice.locale import UnsupportedLocaleError, normalize_locale, normalize_text
from aura_voice.tts import (
    InvalidSynthesisOutputError,
    TtsTimeoutError,
    TtsUnavailableError,
    VoiceCapability,
    VoiceRegistry,
    validate_wav_output,
)


def wav_bytes() -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(22050)
        wav.writeframes(b"\x01\x00" * 100)
    return output.getvalue()


class Engine:
    def __init__(self, audio: bytes = wav_bytes(), delay: float = 0) -> None:
        self.audio = audio
        self.delay = delay
        self.initialized = False

    async def initialize(self) -> None:
        self.initialized = True

    async def synthesize(self, text: str) -> bytes:
        await asyncio.sleep(self.delay)
        return self.audio


def registry(engines, timeout=1):
    return VoiceRegistry(
        engines,
        (
            VoiceCapability(
                "en", ("en", "en-IN", "en-US"), "english", 22050, "supported"
            ),
            VoiceCapability("hi", ("hi", "hi-IN"), "hindi", 22050, "supported"),
            VoiceCapability("te", ("te", "te-IN"), "telugu", 22050, "experimental"),
            VoiceCapability("kn", ("kn", "kn-IN"), None, None, "unsupported"),
        ),
        timeout,
        1024 * 1024,
    )


@pytest.mark.parametrize(
    ("value", "language", "locale"),
    [
        ("en", "en", "en-US"),
        ("en-IN", "en", "en-IN"),
        ("HI_in", "hi", "hi-IN"),
        ("te-IN", "te", "te-IN"),
        ("kn", "kn", "kn-IN"),
    ],
)
def test_normalizes_supported_locales(value, language, locale):
    result = normalize_locale(value, "text")
    assert result.language == language
    assert result.locale == locale


def test_hinglish_is_explicit_latin_mixed_hindi():
    assert normalize_locale("hi-IN", "Namaste main AURA hoon").style == "latin-mixed"
    assert normalize_locale("hi", "नमस्ते").style == "native"


def test_rejects_unknown_locale():
    with pytest.raises(UnsupportedLocaleError):
        normalize_locale("fr", "bonjour")


def test_conservative_text_normalization():
    assert normalize_text("  नमस्ते\n  AURA ") == "नमस्ते AURA"


@pytest.mark.asyncio
async def test_selects_correct_engine_and_unsupported_registered_language():
    english, hindi, telugu = Engine(), Engine(), Engine()
    selected = registry({"en": english, "hi": hindi, "te": telugu})
    await selected.initialize()
    await selected.synthesize("नमस्ते", normalize_locale("hi", "नमस्ते"))
    assert hindi.initialized
    with pytest.raises(TtsUnavailableError):
        await selected.synthesize("ನಮಸ್ಕಾರ", normalize_locale("kn", "ನಮಸ್ಕಾರ"))


@pytest.mark.asyncio
async def test_timeout_and_invalid_output():
    with pytest.raises(TtsTimeoutError):
        await registry({"en": Engine(delay=0.02)}, 0.001).synthesize(
            "hello", normalize_locale("en", "hello")
        )
    with pytest.raises(InvalidSynthesisOutputError):
        await registry({"en": Engine(b"bad")}).synthesize(
            "hello", normalize_locale("en", "hello")
        )


def test_wav_validation_rejects_empty_and_oversized():
    with pytest.raises(InvalidSynthesisOutputError):
        validate_wav_output(b"", 100)
    with pytest.raises(InvalidSynthesisOutputError):
        validate_wav_output(wav_bytes(), 10)
