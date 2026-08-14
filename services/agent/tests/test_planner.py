import pytest

from aura_agent.contracts import (
    AgentRequest,
    RespondPlan,
    ToolExecutionResultContext,
    ToolPlan,
)
from aura_agent.planner import DeterministicDevelopmentPlanner
from aura_agent.tool_catalog import AGENT_TOOL_CATALOG


def test_safe_catalog_contains_exactly_three_capabilities() -> None:
    assert [item["name"] for item in AGENT_TOOL_CATALOG] == [
        "system.echo",
        "utility.calculator",
        "utility.datetime",
        "calendar.events.list",
        "calendar.events.get",
        "calendar.events.create",
        "calendar.events.update",
        "calendar.events.delete",
    ]
    assert all(
        set(item) == {"name", "description", "category", "inputSchema"}
        for item in AGENT_TOOL_CATALOG
    )


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
async def test_calculator_request_proposes_calculator() -> None:
    result = await DeterministicDevelopmentPlanner().plan(
        AgentRequest(message="calculate (10 + 4) / 2")
    )
    assert isinstance(result.plan, ToolPlan)
    assert result.plan.tool.name == "utility.calculator"
    assert result.plan.tool.input == {"expression": "(10 + 4) / 2"}


@pytest.mark.asyncio
async def test_datetime_request_requires_explicit_supported_timezone() -> None:
    result = await DeterministicDevelopmentPlanner().plan(
        AgentRequest(message="what time is it in Asia/Kolkata?")
    )
    assert isinstance(result.plan, ToolPlan)
    assert result.plan.tool.name == "utility.datetime"
    assert result.plan.tool.input == {
        "operation": "current_time",
        "timezone": "Asia/Kolkata",
    }

    ambiguous = await DeterministicDevelopmentPlanner().plan(
        AgentRequest(message="what time is it in Mumbai?")
    )
    assert isinstance(ambiguous.plan, RespondPlan)


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
async def test_utility_results_produce_final_responses() -> None:
    calculator = await DeterministicDevelopmentPlanner().plan(
        AgentRequest(
            message="calculate 6 * 7",
            toolResult=ToolExecutionResultContext(
                tool="utility.calculator", status="success", data={"result": 42}
            ),
        )
    )
    assert isinstance(calculator.plan, RespondPlan)
    assert calculator.response == "The result is 42."

    datetime = await DeterministicDevelopmentPlanner().plan(
        AgentRequest(
            message="time in UTC",
            toolResult=ToolExecutionResultContext(
                tool="utility.datetime",
                status="success",
                data={"timezone": "UTC", "date": "2026-08-14", "time": "12:00:00"},
            ),
        )
    )
    assert isinstance(datetime.plan, RespondPlan)
    assert "UTC" in datetime.response


@pytest.mark.asyncio
async def test_calendar_create_requires_complete_explicit_time_data() -> None:
    result = await DeterministicDevelopmentPlanner().plan(
        AgentRequest(
            message=(
                "schedule Team sync on 2026-08-20 from 10:00 to 10:30 in Asia/Kolkata"
            )
        )
    )
    assert isinstance(result.plan, ToolPlan)
    assert result.plan.tool.name == "calendar.events.create"
    assert result.plan.tool.input == {
        "summary": "Team sync",
        "start": "2026-08-20T10:00:00+05:30",
        "end": "2026-08-20T10:30:00+05:30",
        "timezone": "Asia/Kolkata",
    }
    incomplete = await DeterministicDevelopmentPlanner().plan(
        AgentRequest(message="schedule Team sync tomorrow")
    )
    assert isinstance(incomplete.plan, RespondPlan)


@pytest.mark.asyncio
async def test_calendar_create_result_produces_final_response() -> None:
    result = await DeterministicDevelopmentPlanner().plan(
        AgentRequest(
            message="schedule Team sync",
            toolResult=ToolExecutionResultContext(
                tool="calendar.events.create",
                status="success",
                data={"event": {"title": "Team sync"}},
            ),
        )
    )
    assert isinstance(result.plan, RespondPlan)
    assert result.response == "Done, Team sync has been created on your calendar."


@pytest.mark.asyncio
async def test_calendar_update_and_delete_require_explicit_event_ids() -> None:
    planner = DeterministicDevelopmentPlanner()
    rename = await planner.plan(
        AgentRequest(message="rename calendar event abc123 to Project review")
    )
    assert isinstance(rename.plan, ToolPlan)
    assert rename.plan.tool.name == "calendar.events.update"
    assert rename.plan.tool.input == {
        "eventId": "abc123",
        "summary": "Project review",
    }
    move = await planner.plan(
        AgentRequest(
            message=(
                "move calendar event abc123 to 2026-08-25 from 10:00 to 10:30 "
                "in Asia/Kolkata"
            )
        )
    )
    assert isinstance(move.plan, ToolPlan)
    assert move.plan.tool.name == "calendar.events.update"
    assert move.plan.tool.input["start"] == "2026-08-25T10:00:00+05:30"
    delete = await planner.plan(AgentRequest(message="delete calendar event abc123"))
    assert isinstance(delete.plan, ToolPlan)
    assert delete.plan.tool.name == "calendar.events.delete"
    assert delete.plan.tool.input == {"eventId": "abc123"}
    ambiguous = await planner.plan(AgentRequest(message="delete calendar event"))
    assert isinstance(ambiguous.plan, RespondPlan)


@pytest.mark.asyncio
async def test_calendar_mutation_results_produce_final_responses() -> None:
    planner = DeterministicDevelopmentPlanner()
    updated = await planner.plan(
        AgentRequest(
            message="rename calendar event abc123 to Project review",
            toolResult=ToolExecutionResultContext(
                tool="calendar.events.update",
                status="success",
                data={"event": {"title": "Project review"}},
            ),
        )
    )
    assert isinstance(updated.plan, RespondPlan)
    assert "updated" in updated.response
    deleted = await planner.plan(
        AgentRequest(
            message="delete calendar event abc123",
            toolResult=ToolExecutionResultContext(
                tool="calendar.events.delete",
                status="success",
                data={"eventId": "abc123", "deleted": True},
            ),
        )
    )
    assert isinstance(deleted.plan, RespondPlan)
    assert "deleted" in deleted.response


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
