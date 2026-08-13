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
    ],
)
def test_invalid_settings_fail_fast(field: str, value: object) -> None:
    values: dict[str, object] = {"aura_internal_service_token": "x" * 32, field: value}
    with pytest.raises(ValidationError):
        Settings(**values)  # pyright: ignore[reportArgumentType]
