from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", frozen=True
    )

    app_env: Literal["development", "test", "production"] = "development"
    agent_host: str = Field(default="0.0.0.0", min_length=1)
    agent_port: int = Field(default=8001, ge=1, le=65_535)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    aura_internal_service_token: str = Field(min_length=32)
    aura_allowed_service_id: Literal["gateway"] = "gateway"
    request_body_limit: int = 32 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()  # pyright: ignore[reportCallIssue]
