from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", frozen=True
    )

    app_env: Literal["development", "test", "production"] = "development"
    voice_host: str = Field(default="0.0.0.0", min_length=1)
    voice_port: int = Field(default=8002, ge=1, le=65_535)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    aura_internal_service_token: str = Field(min_length=32)
    aura_allowed_service_id: Literal["gateway"] = "gateway"
    voice_stt_model: str = Field(
        default="../../models/voice/faster-whisper-tiny", min_length=1, max_length=256
    )
    voice_stt_device: Literal["cpu", "cuda", "auto"] = "cpu"
    voice_stt_compute_type: str = Field(default="int8", min_length=1, max_length=32)
    tts_model_root: Path = Path("../../models/voice")
    tts_voice_en: str = "en_US-lessac-medium"
    tts_voice_hi: str = "hi_IN-pratham-medium"
    tts_voice_te: str = "te_IN-padmavathi-medium"
    tts_timeout_seconds: float = Field(default=30, gt=0, le=120)
    tts_max_output_bytes: int = Field(
        default=12 * 1024 * 1024, ge=1024, le=20 * 1024 * 1024
    )
    voice_max_audio_seconds: float = Field(default=30, gt=0, le=60)
    voice_max_audio_bytes: int = Field(
        default=10 * 1024 * 1024, ge=1024, le=20 * 1024 * 1024
    )
    voice_max_tts_characters: int = Field(default=4096, ge=1, le=8192)
    voice_inference_concurrency: int = Field(default=1, ge=1, le=4)


@lru_cache
def get_settings() -> Settings:
    return Settings()  # pyright: ignore[reportCallIssue]
