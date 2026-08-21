import json
from typing import Any

import pytest
from pydantic import ValidationError
from test_llm_planner import FakeInferenceClient

from aura_agent.contracts import AgentRequest, WorkflowPlan
from aura_agent.planner import DeterministicDevelopmentPlanner, SelfHostedLlmPlanner


def valid_plan() -> dict[str, Any]:
    return {
        "type": "workflow",
        "goal": "Prepare for the project meeting",
        "steps": [
            {
                "id": "preferences",
                "kind": "memory_search",
                "dependsOn": [],
                "query": "meeting preferences",
            },
            {
                "id": "notes",
                "kind": "knowledge_search",
                "dependsOn": ["preferences"],
                "query": "project meeting notes",
            },
        ],
    }


def test_valid_bounded_workflow_contract_is_accepted() -> None:
    plan = WorkflowPlan.model_validate(valid_plan())
    assert [step.id for step in plan.steps] == ["preferences", "notes"]


def test_structured_reference_contract_is_ancestor_only_and_strict() -> None:
    plan = reference_plan()
    assert WorkflowPlan.model_validate(plan).steps[1].id == "list"
    plan["steps"][1]["tool"]["input"]["maxResults"]["extra"] = True
    with pytest.raises(ValidationError):
        WorkflowPlan.model_validate(plan)

    plan = reference_plan()
    plan["steps"][1]["dependsOn"] = []
    with pytest.raises(ValidationError, match="ancestor"):
        WorkflowPlan.model_validate(plan)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda plan: plan.update(steps=[]),
        lambda plan: plan.update(steps=[valid_plan()["steps"][0]] * 9),
        lambda plan: plan.update(goal=""),
        lambda plan: plan.update(goal="x" * 1025),
        lambda plan: plan["steps"][1].update(id="preferences"),
        lambda plan: plan["steps"][1].update(id="bad id"),
        lambda plan: plan["steps"][1].update(dependsOn=["missing"]),
        lambda plan: plan["steps"][1].update(dependsOn=["notes"]),
        lambda plan: plan["steps"][1].update(dependsOn=["preferences", "preferences"]),
        lambda plan: plan["steps"][0].update(dependsOn=["notes"]),
        lambda plan: plan["steps"][0].update(kind="shell"),
        lambda plan: plan.update(actorId="attacker"),
        lambda plan: plan["steps"][0].update(permissions=["admin"]),
        lambda plan: plan["steps"][0].update(status="RUNNING"),
        lambda plan: plan["steps"][0].update(result={"secret": True}),
    ],
)
def test_invalid_topology_and_authority_fields_fail_closed(mutate: Any) -> None:
    plan = valid_plan()
    mutate(plan)
    with pytest.raises(ValidationError):
        WorkflowPlan.model_validate(plan)


@pytest.mark.asyncio
async def test_deterministic_workflow_is_narrow_and_simple_actions_stay_single() -> (
    None
):
    planner = DeterministicDevelopmentPlanner()
    workflow = await planner.plan(
        AgentRequest(
            message=(
                "Check my next calendar meeting and then search my saved project "
                "notes for it."
            )
        )
    )
    assert isinstance(workflow.plan, WorkflowPlan)
    assert len(workflow.plan.steps) == 2
    assert (await planner.plan(AgentRequest(message="calculate 12 * 7"))).plan.type == (
        "tool"
    )
    assert (
        await planner.plan(
            AgentRequest(message="What timezone did I ask you to remember?")
        )
    ).plan.type == "memory_search"
    assert (
        await planner.plan(
            AgentRequest(message="Search my knowledge for deployment notes")
        )
    ).plan.type == "knowledge_search"


@pytest.mark.asyncio
async def test_llm_workflow_schema_accepts_valid_and_rejects_malformed_output() -> None:
    output = {
        "intent": "propose_workflow",
        "response": "I can propose that workflow.",
        "plan": valid_plan(),
    }
    result = await SelfHostedLlmPlanner(
        FakeInferenceClient(json.dumps(output)), "test-model"
    ).plan(AgentRequest(message="prepare using my memories and notes"))
    assert isinstance(result.plan, WorkflowPlan)

    referenced = {
        "intent": "propose_workflow",
        "response": "I can use a safe scalar output.",
        "plan": reference_plan(),
    }
    referenced_result = await SelfHostedLlmPlanner(
        FakeInferenceClient(json.dumps(referenced)), "test-model"
    ).plan(AgentRequest(message="calculate a bounded list size"))
    assert isinstance(referenced_result.plan, WorkflowPlan)

    output["plan"]["steps"][0]["retry"] = 3
    with pytest.raises(ValueError, match="Invalid structured model output"):
        await SelfHostedLlmPlanner(
            FakeInferenceClient(json.dumps(output)), "test-model"
        ).plan(AgentRequest(message="unsafe workflow"))

    output = {
        "intent": "propose_workflow",
        "response": "unsafe",
        "plan": valid_plan(),
    }
    output["plan"]["steps"][0] = {
        "id": "unsafe",
        "kind": "tool",
        "dependsOn": [],
        "tool": {"name": "shell.execute", "input": {}},
    }
    with pytest.raises(ValueError, match="Invalid structured model output"):
        await SelfHostedLlmPlanner(
            FakeInferenceClient(json.dumps(output)), "test-model"
        ).plan(AgentRequest(message="unsafe tool workflow"))


@pytest.mark.asyncio
async def test_continuation_schema_cannot_return_workflow() -> None:
    output = {
        "intent": "propose_workflow",
        "response": "unsafe",
        "plan": valid_plan(),
    }
    with pytest.raises(ValueError, match="Invalid structured model output"):
        await SelfHostedLlmPlanner(
            FakeInferenceClient(json.dumps(output)), "test-model"
        ).plan(
            AgentRequest(
                message="saved context",
                memoryContext=[],
            )
        )


def reference_plan() -> dict[str, Any]:
    return {
        "type": "workflow",
        "goal": "Calculate a bounded list size",
        "steps": [
            {
                "id": "calculate",
                "kind": "tool",
                "dependsOn": [],
                "tool": {
                    "name": "utility.calculator",
                    "input": {"expression": "1+2"},
                },
            },
            {
                "id": "list",
                "kind": "tool",
                "dependsOn": ["calculate"],
                "tool": {
                    "name": "calendar.events.list",
                    "input": {
                        "timeMin": "2026-01-01T00:00:00Z",
                        "timeMax": "2026-01-02T00:00:00Z",
                        "maxResults": {"fromStep": "calculate", "field": "result"},
                    },
                },
            },
        ],
    }
