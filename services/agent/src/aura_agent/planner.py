import json
import logging
import time
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from aura_agent.contracts import (
    AgentRequest,
    AgentResult,
    RespondPlan,
    ToolPlan,
    ToolProposal,
)
from aura_agent.inference import ChatMessage, InferenceClient
from aura_agent.prompt import SYSTEM_PROMPT, SYSTEM_PROMPT_VERSION
from aura_agent.tool_catalog import AGENT_TOOL_CATALOG

logger = logging.getLogger("aura.agent.planner")


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


class _RespondOutputPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["respond"]


class _EchoInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(min_length=1, max_length=8192)


class _EchoTool(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Literal["system.echo"]
    input: _EchoInput


class _ToolOutputPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["tool"]
    tool: _EchoTool


class _RespondOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: Literal["respond"]
    response: str = Field(min_length=1, max_length=8192)
    plan: _RespondOutputPlan


class _ToolOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: Literal["propose_tool"]
    response: str = Field(min_length=1, max_length=8192)
    plan: _ToolOutputPlan


class SelfHostedLlmPlanner:
    def __init__(self, inference: InferenceClient, model_name: str) -> None:
        self._inference = inference
        self._model_name = model_name

    async def plan(self, request: AgentRequest) -> AgentResult:
        started = time.perf_counter()
        messages = [ChatMessage(role="system", content=SYSTEM_PROMPT)]
        if request.tool_result is None:
            messages.append(
                ChatMessage(
                    role="user",
                    content=json.dumps(
                        {
                            "untrustedUserMessage": request.message,
                            "localeHint": request.locale,
                        },
                        ensure_ascii=False,
                    ),
                )
            )
            output_type: type[_RespondOutput] | type[_ToolOutput] = _ToolOutput
            schema = _initial_output_schema()
        else:
            messages.append(
                ChatMessage(
                    role="user",
                    content=json.dumps(
                        {
                            "untrustedUserMessage": request.message,
                            "successfulToolResultData": request.tool_result.model_dump(
                                by_alias=True
                            ),
                            "instruction": (
                                "Return the final response. Do not propose a tool."
                            ),
                        },
                        ensure_ascii=False,
                    ),
                )
            )
            output_type = _RespondOutput
            schema = _respond_output_schema()

        raw = await self._inference.complete(messages, schema)
        try:
            decoded = json.loads(raw)
            if request.tool_result is None:
                output = _parse_initial_output(decoded)
            else:
                output = output_type.model_validate(decoded)
        except (json.JSONDecodeError, ValidationError) as error:
            raise ValueError("Invalid structured model output") from error

        result = _to_agent_result(output)
        logger.info(
            "LLM planning completed",
            extra={
                "plannerMode": "llm",
                "modelName": self._model_name,
                "modelRuntime": "llama.cpp",
                "promptCharacters": sum(len(item.content) for item in messages),
                "completionCharacters": len(raw),
                "durationMs": round((time.perf_counter() - started) * 1000, 3),
                "planType": result.plan.type,
                "toolName": (
                    result.plan.tool.name if isinstance(result.plan, ToolPlan) else None
                ),
                "promptVersion": SYSTEM_PROMPT_VERSION,
            },
        )
        return result


def _initial_output_schema() -> dict[str, object]:
    return {
        "oneOf": [
            _respond_output_schema(),
            {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "intent": {"const": "propose_tool"},
                    "response": {"type": "string", "minLength": 1},
                    "plan": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "type": {"const": "tool"},
                            "tool": {
                                "type": "object",
                                "additionalProperties": False,
                                "properties": {
                                    "name": {"const": AGENT_TOOL_CATALOG[0]["name"]},
                                    "input": AGENT_TOOL_CATALOG[0]["inputSchema"],
                                },
                                "required": ["name", "input"],
                            },
                        },
                        "required": ["type", "tool"],
                    },
                },
                "required": ["intent", "response", "plan"],
            },
        ]
    }


def _respond_output_schema() -> dict[str, object]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "intent": {"const": "respond"},
            "response": {"type": "string", "minLength": 1},
            "plan": {
                "type": "object",
                "additionalProperties": False,
                "properties": {"type": {"const": "respond"}},
                "required": ["type"],
            },
        },
        "required": ["intent", "response", "plan"],
    }


def _parse_initial_output(value: object) -> _RespondOutput | _ToolOutput:
    try:
        return _RespondOutput.model_validate(value)
    except ValidationError:
        return _ToolOutput.model_validate(value)


def _to_agent_result(output: _RespondOutput | _ToolOutput) -> AgentResult:
    if isinstance(output, _RespondOutput):
        return AgentResult(
            intent=output.intent,
            response=output.response,
            plan=RespondPlan(),
        )
    return AgentResult(
        intent=output.intent,
        response=output.response,
        plan=ToolPlan(
            tool=ToolProposal(
                name=output.plan.tool.name,
                input=output.plan.tool.input.model_dump(),
            )
        ),
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
