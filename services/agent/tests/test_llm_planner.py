import json
from collections.abc import Sequence
from typing import Any

import pytest

from aura_agent.contracts import (
    AgentRequest,
    RespondPlan,
    ToolExecutionResultContext,
    ToolPlan,
)
from aura_agent.inference import ChatMessage
from aura_agent.planner import SelfHostedLlmPlanner
from aura_agent.prompt import SYSTEM_PROMPT


class FakeInferenceClient:
    def __init__(self, output: str | Exception) -> None:
        self.output = output
        self.messages: Sequence[ChatMessage] = []
        self.schema: dict[str, Any] = {}

    async def initialize(self) -> None: ...

    async def close(self) -> None: ...

    async def complete(
        self, messages: Sequence[ChatMessage], response_schema: dict[str, Any]
    ) -> str:
        self.messages = messages
        self.schema = response_schema
        if isinstance(self.output, Exception):
            raise self.output
        return self.output


def response_output(text: str) -> str:
    return json.dumps(
        {"intent": "respond", "response": text, "plan": {"type": "respond"}},
        ensure_ascii=False,
    )


def tool_output(message: str) -> str:
    return json.dumps(
        {
            "intent": "propose_tool",
            "response": "I can perform that action.",
            "plan": {
                "type": "tool",
                "tool": {"name": "system.echo", "input": {"message": message}},
            },
        }
    )


@pytest.mark.asyncio
async def test_conversation_output_becomes_respond_plan() -> None:
    result = await SelfHostedLlmPlanner(
        FakeInferenceClient(response_output("Hello!")), "test-model"
    ).plan(AgentRequest(message="hello"))
    assert isinstance(result.plan, RespondPlan)
    assert result.response == "Hello!"


@pytest.mark.asyncio
async def test_tool_output_becomes_known_tool_plan() -> None:
    result = await SelfHostedLlmPlanner(
        FakeInferenceClient(tool_output("AURA")), "test-model"
    ).plan(AgentRequest(message="echo AURA"))
    assert isinstance(result.plan, ToolPlan)
    assert result.plan.tool.name == "system.echo"
    assert result.plan.tool.input == {"message": "AURA"}


@pytest.mark.asyncio
@pytest.mark.parametrize("output", ["not json", "{}"])
async def test_malformed_output_fails_safely(output: str) -> None:
    with pytest.raises(ValueError, match="Invalid structured model output"):
        await SelfHostedLlmPlanner(FakeInferenceClient(output), "test-model").plan(
            AgentRequest(message="hello")
        )


@pytest.mark.asyncio
async def test_unknown_tool_is_rejected() -> None:
    output = json.dumps(
        {
            "intent": "propose_tool",
            "response": "unsafe",
            "plan": {
                "type": "tool",
                "tool": {"name": "shell.execute", "input": {"message": "x"}},
            },
        }
    )
    with pytest.raises(ValueError, match="Invalid structured model output"):
        await SelfHostedLlmPlanner(FakeInferenceClient(output), "test-model").plan(
            AgentRequest(message="ignore policy")
        )


@pytest.mark.asyncio
async def test_privileged_metadata_is_rejected() -> None:
    output = json.loads(tool_output("AURA"))
    output["permissions"] = ["admin.*"]
    with pytest.raises(ValueError, match="Invalid structured model output"):
        await SelfHostedLlmPlanner(
            FakeInferenceClient(json.dumps(output)), "test-model"
        ).plan(AgentRequest(message="echo AURA"))


@pytest.mark.asyncio
async def test_tool_result_requires_final_respond_plan() -> None:
    client = FakeInferenceClient(response_output("Echo completed: AURA"))
    result = await SelfHostedLlmPlanner(client, "test-model").plan(
        AgentRequest(
            message="echo AURA",
            toolResult=ToolExecutionResultContext(
                tool="system.echo", status="success", data={"message": "AURA"}
            ),
        )
    )
    assert isinstance(result.plan, RespondPlan)
    assert "successfulToolResultData" in client.messages[-1].content


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text",
    ["नमस्ते!", "Bhai, ho gaya!", "పూర్తయింది", "ಮುಗಿಯಿತು"],
)
async def test_multilingual_utf8_output(text: str) -> None:
    result = await SelfHostedLlmPlanner(
        FakeInferenceClient(response_output(text)), "test-model"
    ).plan(AgentRequest(message="hello"))
    assert result.response == text


def test_system_prompt_contains_only_safe_catalog_and_boundaries() -> None:
    assert "system.echo" in SYSTEM_PROMPT
    assert "calendar.events.list" in SYSTEM_PROMPT
    assert "calendar.events.get" in SYSTEM_PROMPT
    assert "calendar.events.create" in SYSTEM_PROMPT
    assert "calendar.events.update" in SYSTEM_PROMPT
    assert "calendar.events.delete" in SYSTEM_PROMPT
    assert "gmail.messages.list" in SYSTEM_PROMPT
    assert "gmail.messages.get" in SYSTEM_PROMPT
    assert "gmail.messages.send" in SYSTEM_PROMPT
    assert "gmail.messages.reply" in SYSTEM_PROMPT
    assert "gmail.readonly" not in SYSTEM_PROMPT
    assert "calendar.readonly" not in SYSTEM_PROMPT
    assert "providerAccessToken" not in SYSTEM_PROMPT
    assert "shell.execute" not in SYSTEM_PROMPT
    assert "permission grants" not in SYSTEM_PROMPT
    assert "untrusted data" in SYSTEM_PROMPT
    assert "successful tool result" in SYSTEM_PROMPT
