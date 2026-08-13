from typing import Protocol

from aura_agent.contracts import (
    AgentRequest,
    AgentResult,
    RespondPlan,
    ToolPlan,
    ToolProposal,
)


class Planner(Protocol):
    async def plan(self, request: AgentRequest) -> AgentResult: ...


class DeterministicDevelopmentPlanner:
    async def plan(self, request: AgentRequest) -> AgentResult:
        if request.tool_result is not None:
            result = request.tool_result
            if result.tool != "system.echo":
                raise ValueError("Unsupported tool result")
            message = result.data.get("message")
            if not isinstance(message, str):
                raise ValueError("Invalid echo result")
            return AgentResult(
                intent="respond",
                response=f"Echo completed successfully: {message}",
                plan=RespondPlan(),
            )

        command, separator, content = request.message.partition(" ")
        if command.casefold() == "echo" and separator and content.strip():
            return AgentResult(
                intent="propose_tool",
                response="I can propose the echo tool for that request.",
                plan=ToolPlan(
                    tool=ToolProposal(
                        name="system.echo", input={"message": content.strip()}
                    )
                ),
            )

        return AgentResult(
            intent="respond",
            response="Agent planning foundation is active.",
            plan=RespondPlan(),
        )


class AgentPlanningError(Exception):
    pass


class AgentService:
    def __init__(self, planner: Planner) -> None:
        self._planner = planner

    async def respond(self, request: AgentRequest) -> AgentResult:
        try:
            return await self._planner.plan(request)
        except Exception as error:
            raise AgentPlanningError from error
