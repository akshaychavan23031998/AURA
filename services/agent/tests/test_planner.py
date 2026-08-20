import pytest

from aura_agent.contracts import (
    AgentRequest,
    KnowledgeContextItem,
    KnowledgeSearchPlan,
    MemoryContextItem,
    MemoryCreatePlan,
    MemoryDeletePlan,
    MemoryMutationResultContext,
    MemoryReadPlan,
    MemorySearchPlan,
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
        "gmail.messages.list",
        "gmail.messages.get",
        "gmail.messages.send",
        "gmail.messages.reply",
        "contacts.people.list",
        "contacts.people.get",
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
async def test_gmail_read_plans_are_narrow_and_require_message_ids() -> None:
    planner = DeterministicDevelopmentPlanner()
    latest = await planner.plan(AgentRequest(message="show my latest emails"))
    assert isinstance(latest.plan, ToolPlan)
    assert latest.plan.tool.name == "gmail.messages.list"
    assert latest.plan.tool.input == {"maxResults": 10}
    searched = await planner.plan(AgentRequest(message="find emails about interview"))
    assert isinstance(searched.plan, ToolPlan)
    assert searched.plan.tool.input == {"maxResults": 10, "query": "interview"}
    message = await planner.plan(AgentRequest(message="read email abc123"))
    assert isinstance(message.plan, ToolPlan)
    assert message.plan.tool.name == "gmail.messages.get"
    assert message.plan.tool.input == {"messageId": "abc123"}
    ambiguous = await planner.plan(AgentRequest(message="read email"))
    assert isinstance(ambiguous.plan, RespondPlan)


@pytest.mark.asyncio
async def test_gmail_results_continue_to_final_response() -> None:
    planner = DeterministicDevelopmentPlanner()
    listed = await planner.plan(
        AgentRequest(
            message="show my latest emails",
            toolResult=ToolExecutionResultContext(
                tool="gmail.messages.list",
                status="success",
                data={"messages": []},
            ),
        )
    )
    assert isinstance(listed.plan, RespondPlan)
    assert listed.response == "I found 0 email messages."
    fetched = await planner.plan(
        AgentRequest(
            message="read email abc123",
            toolResult=ToolExecutionResultContext(
                tool="gmail.messages.get",
                status="success",
                data={"message": {"subject": "Interview"}},
            ),
        )
    )
    assert isinstance(fetched.plan, RespondPlan)
    assert fetched.response == "The email subject is: Interview"


@pytest.mark.asyncio
async def test_gmail_send_and_reply_plans_are_explicit_and_narrow() -> None:
    planner = DeterministicDevelopmentPlanner()
    send = await planner.plan(
        AgentRequest(
            message=(
                "send email to alice@example.com subject Project update "
                "body Deployment is complete"
            )
        )
    )
    assert isinstance(send.plan, ToolPlan)
    assert send.plan.tool.name == "gmail.messages.send"
    assert send.plan.tool.input == {
        "to": "alice@example.com",
        "subject": "Project update",
        "body": "Deployment is complete",
    }
    reply = await planner.plan(
        AgentRequest(message="reply to gmail message abc123 with Thanks")
    )
    assert isinstance(reply.plan, ToolPlan)
    assert reply.plan.tool.name == "gmail.messages.reply"
    assert reply.plan.tool.input == {"messageId": "abc123", "body": "Thanks"}
    assert isinstance(
        (await planner.plan(AgentRequest(message="send email"))).plan, RespondPlan
    )
    assert isinstance(
        (
            await planner.plan(AgentRequest(message="reply to gmail message abc123"))
        ).plan,
        RespondPlan,
    )


@pytest.mark.asyncio
async def test_gmail_send_and_reply_results_continue_once() -> None:
    planner = DeterministicDevelopmentPlanner()
    send = await planner.plan(
        AgentRequest(
            message="send email",
            toolResult=ToolExecutionResultContext(
                tool="gmail.messages.send",
                status="success",
                data={"messageId": "sent-1", "threadId": "thread-1", "sent": True},
            ),
        )
    )
    reply = await planner.plan(
        AgentRequest(
            message="reply",
            toolResult=ToolExecutionResultContext(
                tool="gmail.messages.reply",
                status="success",
                data={"messageId": "reply-1", "threadId": "thread-1", "sent": True},
            ),
        )
    )
    assert isinstance(send.plan, RespondPlan)
    assert send.response == "The email was sent successfully."
    assert isinstance(reply.plan, RespondPlan)
    assert reply.response == "The reply was sent successfully."


@pytest.mark.asyncio
async def test_contacts_plans_and_continuation_are_narrow() -> None:
    planner = DeterministicDevelopmentPlanner()
    listed = await planner.plan(AgentRequest(message="list my contacts"))
    assert isinstance(listed.plan, ToolPlan)
    assert listed.plan.tool.name == "contacts.people.list"
    fetched = await planner.plan(AgentRequest(message="get contact people/c123"))
    assert isinstance(fetched.plan, ToolPlan)
    assert fetched.plan.tool.input == {"resourceName": "people/c123"}
    ambiguous = await planner.plan(AgentRequest(message="find John"))
    assert isinstance(ambiguous.plan, RespondPlan)
    continued = await planner.plan(
        AgentRequest(
            message="list",
            toolResult=ToolExecutionResultContext(
                tool="contacts.people.list", status="success", data={"contacts": []}
            ),
        )
    )
    assert continued.response == "I found 0 contacts."


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


@pytest.mark.asyncio
async def test_memory_create_requires_explicit_intent() -> None:
    planner = DeterministicDevelopmentPlanner()
    explicit = await planner.plan(
        AgentRequest(message="Remember that I prefer dark mode.")
    )
    assert isinstance(explicit.plan, MemoryCreatePlan)
    assert explicit.plan.kind == "preference"
    assert explicit.plan.content == "I prefer dark mode."
    ordinary = await planner.plan(AgentRequest(message="I prefer dark mode."))
    assert isinstance(ordinary.plan, RespondPlan)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("message", "query"),
    [
        ("What timezone did I ask you to remember?", "timezone"),
        ("What did I save about deployment?", "deployment"),
        ("What coding language do I prefer?", "coding language preference"),
    ],
)
async def test_semantic_memory_search_requires_explicit_saved_memory_intent(
    message: str, query: str
) -> None:
    result = await DeterministicDevelopmentPlanner().plan(AgentRequest(message=message))
    assert isinstance(result.plan, MemorySearchPlan)
    assert result.plan.query == query


@pytest.mark.asyncio
async def test_unrelated_requests_do_not_search_memory() -> None:
    result = await DeterministicDevelopmentPlanner().plan(
        AgentRequest(message="What's the weather?")
    )
    assert not isinstance(result.plan, MemorySearchPlan)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("message", "query"),
    [
        (
            "Search my knowledge for the authentication architecture.",
            "the authentication architecture",
        ),
        ("Based on my knowledge base, PostgreSQL migrations?", "PostgreSQL migrations"),
        ("What does my saved document say about OAuth?", "OAuth"),
    ],
)
async def test_saved_knowledge_requests_propose_bounded_search(
    message: str, query: str
) -> None:
    result = await DeterministicDevelopmentPlanner().plan(AgentRequest(message=message))
    assert isinstance(result.plan, KnowledgeSearchPlan)
    assert result.plan.query == query


@pytest.mark.asyncio
async def test_ordinary_question_does_not_search_knowledge() -> None:
    result = await DeterministicDevelopmentPlanner().plan(
        AgentRequest(message="Explain OAuth in general")
    )
    assert not isinstance(result.plan, KnowledgeSearchPlan)


@pytest.mark.asyncio
async def test_knowledge_continuation_is_final_and_cites_supplied_reference() -> None:
    result = await DeterministicDevelopmentPlanner().plan(
        AgentRequest(
            message="What does my saved document say about OAuth?",
            knowledgeContext=[
                KnowledgeContextItem(
                    reference="K1",
                    title="Architecture",
                    content="OAuth uses PKCE.",
                    ordinal=0,
                )
            ],
        )
    )
    assert isinstance(result.plan, RespondPlan)
    assert result.citation_ids == ["K1"]
    assert "[K1]" in result.response


@pytest.mark.asyncio
async def test_memory_read_and_exact_delete_require_explicit_intent() -> None:
    planner = DeterministicDevelopmentPlanner()
    read = await planner.plan(AgentRequest(message="What do you remember about me?"))
    assert isinstance(read.plan, MemoryReadPlan)
    assert read.plan.kind is None
    preference = await planner.plan(
        AgentRequest(message="What preferences have I asked you to remember?")
    )
    assert isinstance(preference.plan, MemoryReadPlan)
    assert preference.plan.kind == "preference"
    memory_id = "00000000-0000-4000-8000-000000000010"
    deleted = await planner.plan(AgentRequest(message=f"Forget memory {memory_id}"))
    assert isinstance(deleted.plan, MemoryDeletePlan)
    assert deleted.plan.memory_id == memory_id
    ambiguous = await planner.plan(
        AgentRequest(message="Forget my preference about dark mode")
    )
    assert isinstance(ambiguous.plan, RespondPlan)


@pytest.mark.asyncio
async def test_memory_continuations_are_final_and_use_only_returned_context() -> None:
    planner = DeterministicDevelopmentPlanner()
    memory_id = "00000000-0000-4000-8000-000000000010"
    listed = await planner.plan(
        AgentRequest(
            message="What do you remember about me?",
            memoryContext=[
                MemoryContextItem(
                    id=memory_id, kind="note", content="User-provided context"
                )
            ],
        )
    )
    assert isinstance(listed.plan, RespondPlan)
    assert memory_id in listed.response
    empty = await planner.plan(
        AgentRequest(message="What do you remember?", memoryContext=[])
    )
    assert empty.response == "You have no explicit saved memories."
    no_match = await planner.plan(
        AgentRequest(
            message="What timezone did I ask you to remember?", memoryContext=[]
        )
    )
    assert no_match.response == "I found no matching explicit saved memories."
    created = await planner.plan(
        AgentRequest(
            message="Remember this",
            memoryResult=MemoryMutationResultContext(
                operation="created",
                memory=MemoryContextItem(id=memory_id, kind="note", content="safe"),
            ),
        )
    )
    assert isinstance(created.plan, RespondPlan)
    deleted = await planner.plan(
        AgentRequest(
            message="Forget memory",
            memoryResult=MemoryMutationResultContext(
                operation="deleted", memoryId=memory_id
            ),
        )
    )
    assert isinstance(deleted.plan, RespondPlan)
