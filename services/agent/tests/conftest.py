import pytest
from fastapi.testclient import TestClient

from aura_agent.app import create_app
from aura_agent.config import Settings

TOKEN = "agent-test-token-at-least-32-characters"


@pytest.fixture
def settings() -> Settings:
    return Settings(
        app_env="test",
        agent_host="127.0.0.1",
        agent_port=8001,
        log_level="CRITICAL",
        aura_internal_service_token=TOKEN,
    )


@pytest.fixture
def client(settings: Settings) -> TestClient:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"x-aura-service-id": "gateway", "x-aura-service-token": TOKEN}
