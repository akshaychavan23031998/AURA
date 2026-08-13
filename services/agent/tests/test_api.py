from collections.abc import Sequence
from typing import Any

import pytest
from fastapi.testclient import TestClient

from aura_agent.app import create_app
from aura_agent.config import Settings
from aura_agent.contracts import AgentRequest, AgentResult
from aura_agent.inference import ChatMessage


def test_health_and_readiness_are_public(client: TestClient) -> None:
    assert client.get("/health").json() == {"status": "ok", "service": "agent"}
    assert client.get("/ready").json() == {"status": "ready", "service": "agent"}


def test_respond_requires_internal_authentication(client: TestClient) -> None:
    response = client.post("/v1/agent/respond", json={"message": "hello"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"


def test_returns_tool_proposal_without_executing_it(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    response = client.post(
        "/v1/agent/respond",
        headers={**auth_headers, "x-request-id": "correlation-1"},
        json={"message": "echo hello"},
    )
    assert response.status_code == 200
    assert response.headers["x-request-id"] == "correlation-1"
    assert response.json() == {
        "intent": "propose_tool",
        "response": "I can propose the echo tool for that request.",
        "plan": {
            "type": "tool",
            "tool": {"name": "system.echo", "input": {"message": "hello"}},
        },
        "requestId": "correlation-1",
    }


def test_rejects_unknown_and_privileged_fields(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    response = client.post(
        "/v1/agent/respond",
        headers=auth_headers,
        json={"message": "hello", "grantedPermissions": ["system.echo"]},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


def test_replaces_malformed_request_id(client: TestClient) -> None:
    response = client.get("/health", headers={"x-request-id": "bad id"})
    assert response.headers["x-request-id"] != "bad id"


def test_rejects_oversized_payload(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    response = client.post(
        "/v1/agent/respond", headers=auth_headers, json={"message": "x" * 33_000}
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_planner_failure_returns_safe_error(settings: Settings) -> None:
    class FailingPlanner:
        async def plan(self, request: AgentRequest) -> AgentResult:
            del request
            raise RuntimeError("private planner detail")

    with TestClient(create_app(settings, FailingPlanner())) as failing_client:
        response = failing_client.post(
            "/v1/agent/respond",
            headers={
                "x-aura-service-id": "gateway",
                "x-aura-service-token": settings.aura_internal_service_token,
            },
            json={"message": "hello"},
        )
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "AGENT_PLANNING_FAILED"
    assert "private planner detail" not in response.text


def test_authenticated_gateway_can_supply_tool_result(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    response = client.post(
        "/v1/agent/respond",
        headers=auth_headers,
        json={
            "message": "echo AURA",
            "toolResult": {
                "tool": "system.echo",
                "status": "success",
                "data": {"message": "AURA"},
            },
        },
    )
    assert response.status_code == 200
    assert response.json()["response"] == "Echo completed successfully: AURA"
    assert response.json()["plan"] == {"type": "respond"}


def test_llm_readiness_initializes_injected_runtime(settings: Settings) -> None:
    class ReadyInference:
        initialized = False
        closed = False

        async def initialize(self) -> None:
            self.initialized = True

        async def close(self) -> None:
            self.closed = True

        async def complete(
            self,
            messages: Sequence[ChatMessage],
            response_schema: dict[str, Any],
        ) -> str:
            del messages, response_schema
            return '{"intent":"respond","response":"ok","plan":{"type":"respond"}}'

    inference = ReadyInference()
    llm_settings = settings.model_copy(
        update={
            "agent_planner_mode": "llm",
            "llm_base_url": "http://127.0.0.1:8080",
            "llm_model_name": "test-model",
        }
    )
    with TestClient(create_app(llm_settings, inference_client=inference)) as llm_client:
        assert llm_client.get("/ready").status_code == 200
        assert inference.initialized
    assert inference.closed


def test_llm_startup_fails_when_runtime_is_unavailable(settings: Settings) -> None:
    class UnavailableInference:
        async def initialize(self) -> None:
            raise RuntimeError("runtime unavailable")

        async def close(self) -> None: ...

        async def complete(
            self,
            messages: Sequence[ChatMessage],
            response_schema: dict[str, Any],
        ) -> str:
            del messages, response_schema
            raise AssertionError("completion must not run")

    llm_settings = settings.model_copy(
        update={
            "agent_planner_mode": "llm",
            "llm_base_url": "http://127.0.0.1:8080",
            "llm_model_name": "test-model",
        }
    )
    with pytest.raises(RuntimeError, match="runtime unavailable"):
        with TestClient(
            create_app(llm_settings, inference_client=UnavailableInference())
        ):
            pass
