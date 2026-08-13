import pytest

from aura_agent.contracts import (
    AgentRequest,
    RespondPlan,
    ToolExecutionResultContext,
    ToolPlan,
)
from aura_agent.planner import DeterministicDevelopmentPlanner


@pytest.mark.asyncio
async def test_echo_proposes_a_tool() -> None:
    result = await DeterministicDevelopmentPlanner().plan(
        AgentRequest(message="echo bonjour")
    )
    assert isinstance(result.plan, ToolPlan)
    assert result.plan.tool.name == "system.echo"
    assert result.plan.tool.input == {"message": "bonjour"}


@pytest.mark.asyncio
async def test_echo_without_content_responds_safely() -> None:
    result = await DeterministicDevelopmentPlanner().plan(AgentRequest(message="echo"))
    assert isinstance(result.plan, RespondPlan)


@pytest.mark.asyncio
async def test_successful_echo_result_produces_final_response() -> None:
    result = await DeterministicDevelopmentPlanner().plan(
        AgentRequest(
            message="echo AURA",
            toolResult=ToolExecutionResultContext(
                tool="system.echo", status="success", data={"message": "AURA"}
            ),
        )
    )
    assert isinstance(result.plan, RespondPlan)
    assert result.response == "Echo completed successfully: AURA"


@pytest.mark.asyncio
async def test_unexpected_tool_result_fails_safely() -> None:
    with pytest.raises(ValueError, match="Unsupported tool result"):
        await DeterministicDevelopmentPlanner().plan(
            AgentRequest(
                message="hello",
                toolResult=ToolExecutionResultContext(
                    tool="unknown.tool", status="success", data={}
                ),
            )
        )
