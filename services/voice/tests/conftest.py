import io
import wave
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from aura_voice.app import create_app
from aura_voice.config import Settings
from aura_voice.contracts import TranscriptionResult

TOKEN = "voice-test-token-at-least-32-characters"


class FakeTranscriber:
    async def initialize(self) -> None:
        pass

    async def transcribe(self, audio, language_hint):
        return TranscriptionResult(
            text="echo AURA",
            detectedLanguage=language_hint or "en",
            durationMs=audio.duration_ms,
        )


class FakeSynthesizer:
    async def initialize(self) -> None:
        pass

    async def synthesize(self, text, locale):
        return wav_bytes()


def wav_bytes(seconds: float = 0.1) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16_000)
        wav.writeframes(b"\x01\x00" * int(16_000 * seconds))
    return output.getvalue()


@pytest.fixture
def settings() -> Settings:
    return Settings(
        app_env="test",
        voice_host="127.0.0.1",
        voice_port=8002,
        log_level="CRITICAL",
        aura_internal_service_token=TOKEN,
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(
        create_app(settings, FakeTranscriber(), FakeSynthesizer())
    ) as test_client:
        yield test_client


@pytest.fixture
def headers() -> dict[str, str]:
    return {
        "x-aura-service-id": "gateway",
        "x-aura-service-token": TOKEN,
        "x-request-id": "voice-test-1",
    }


@pytest.fixture
def wav_bytes_fixture() -> bytes:
    return wav_bytes()
