import pytest

from aura_agent.contracts import AgentRequest, RespondPlan, ToolPlan
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
