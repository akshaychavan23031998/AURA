import pytest
from pydantic import ValidationError

from aura_agent.config import Settings


def test_valid_settings_are_immutable() -> None:
    settings = Settings(aura_internal_service_token="x" * 32)
    assert settings.agent_port == 8001
    with pytest.raises(ValidationError):
        settings.agent_port = 1  # pyright: ignore[reportAttributeAccessIssue]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("agent_port", 0),
        ("app_env", "staging"),
        ("aura_internal_service_token", "short"),
        ("llm_context_size", 512),
        ("llm_max_output_tokens", 10),
        ("llm_temperature", 2),
        ("llm_request_timeout_seconds", 0),
    ],
)
def test_invalid_settings_fail_fast(field: str, value: object) -> None:
    values: dict[str, object] = {"aura_internal_service_token": "x" * 32, field: value}
    with pytest.raises(ValidationError):
        Settings(**values)  # pyright: ignore[reportArgumentType]


def test_deterministic_mode_is_safe_default() -> None:
    settings = Settings(aura_internal_service_token="x" * 32)
    assert settings.agent_planner_mode == "deterministic"


def test_llm_mode_requires_runtime_and_model() -> None:
    with pytest.raises(ValidationError, match="LLM_BASE_URL and LLM_MODEL_NAME"):
        Settings(
            aura_internal_service_token="x" * 32,
            agent_planner_mode="llm",
        )


def test_valid_llm_settings() -> None:
    settings = Settings(
        aura_internal_service_token="x" * 32,
        agent_planner_mode="llm",
        llm_base_url="http://127.0.0.1:8080",
        llm_model_name="Qwen3-4B-Q4_K_M.gguf",
    )
    assert settings.llm_context_size == 4096
    assert settings.llm_max_output_tokens == 256
