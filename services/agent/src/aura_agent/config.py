from functools import lru_cache
from typing import Literal

from pydantic import Field, HttpUrl, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_ignore_empty=True,
        extra="ignore",
        frozen=True,
    )

    app_env: Literal["development", "test", "production"] = "development"
    agent_host: str = Field(default="0.0.0.0", min_length=1)
    agent_port: int = Field(default=8001, ge=1, le=65_535)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    aura_internal_service_token: str = Field(min_length=32)
    aura_allowed_service_id: Literal["gateway"] = "gateway"
    request_body_limit: int = 32 * 1024
    agent_planner_mode: Literal["deterministic", "llm"] = "deterministic"
    llm_base_url: HttpUrl | None = None
    llm_model_name: str | None = Field(default=None, min_length=1, max_length=128)
    llm_context_size: int = Field(default=4096, ge=1024, le=32768)
    llm_max_output_tokens: int = Field(default=256, ge=64, le=1024)
    llm_temperature: float = Field(default=0.1, ge=0, le=1)
    llm_request_timeout_seconds: float = Field(default=120, ge=1, le=600)

    @model_validator(mode="after")
    def validate_llm_mode(self) -> "Settings":
        if self.agent_planner_mode == "llm" and (
            self.llm_base_url is None or self.llm_model_name is None
        ):
            raise ValueError(
                "LLM_BASE_URL and LLM_MODEL_NAME are required in llm planner mode"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()  # pyright: ignore[reportCallIssue]
