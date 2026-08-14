import json
import logging
import re
import time
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta, timezone
from typing import Literal, Protocol, cast

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    ValidationError,
    model_validator,
)

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
            known_tools = {cast(str, item["name"]) for item in AGENT_TOOL_CATALOG}
            if result.tool not in known_tools:
                raise ValueError("Unsupported tool result")
            if result.tool == "system.echo":
                message = result.data.get("message")
                if not isinstance(message, str):
                    raise ValueError("Invalid echo result")
                response = f"Echo completed successfully: {message}"
            elif result.tool == "utility.calculator":
                value = result.data.get("result")
                if not isinstance(value, int | float):
                    raise ValueError("Invalid calculator result")
                response = f"The result is {value}."
            elif result.tool == "utility.datetime":
                timezone = result.data.get("timezone")
                date = result.data.get("date")
                current_time = result.data.get("time")
                if not all(
                    isinstance(item, str) for item in (timezone, date, current_time)
                ):
                    raise ValueError("Invalid datetime result")
                response = (
                    f"In {timezone}, the date is {date} and the time is {current_time}."
                )
            elif result.tool == "calendar.events.create":
                event = result.data.get("event")
                if not isinstance(event, dict) or not isinstance(
                    event.get("title"), str
                ):
                    raise ValueError("Invalid calendar create result")
                response = f"Done, {event['title']} has been created on your calendar."
            else:
                response = "Your calendar request completed successfully."
            return AgentResult(
                intent="respond",
                response=response,
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

        normalized = request.message.strip()
        lowered = normalized.casefold()
        expression = None
        if lowered.startswith("calculate "):
            expression = normalized[len("calculate ") :].strip()
        elif lowered.startswith("what is ") and normalized.endswith("?"):
            expression = normalized[len("what is ") : -1].strip()
        if expression:
            return AgentResult(
                intent="propose_tool",
                response="I can calculate that.",
                plan=ToolPlan(
                    tool=ToolProposal(
                        name="utility.calculator", input={"expression": expression}
                    )
                ),
            )

        for timezone in ("Asia/Kolkata", "UTC"):
            if timezone.casefold() in lowered and (
                "time" in lowered or "date" in lowered
            ):
                operation = "current_date" if "date" in lowered else "current_time"
                return AgentResult(
                    intent="propose_tool",
                    response="I can check the current server-observed time.",
                    plan=ToolPlan(
                        tool=ToolProposal(
                            name="utility.datetime",
                            input={"operation": operation, "timezone": timezone},
                        )
                    ),
                )

        calendar_create = _parse_deterministic_calendar_create(normalized)
        if calendar_create is not None:
            return AgentResult(
                intent="propose_tool",
                response="I can create that event after your explicit approval.",
                plan=ToolPlan(
                    tool=ToolProposal(
                        name="calendar.events.create", input=calendar_create
                    )
                ),
            )
        if lowered.startswith(("create a calendar event", "schedule ")):
            return AgentResult(
                intent="respond",
                response=(
                    "Please provide the event title, date, start time, end time, "
                    "and an explicit IANA timezone."
                ),
                plan=RespondPlan(),
            )

        return AgentResult(
            intent="respond",
            response="Agent planning foundation is active.",
            plan=RespondPlan(),
        )


class _RespondOutputPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["respond"]


class _CatalogTool(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Literal[
        "system.echo",
        "utility.calculator",
        "utility.datetime",
        "calendar.events.list",
        "calendar.events.get",
        "calendar.events.create",
    ]
    input: dict[str, JsonValue]

    @model_validator(mode="after")
    def validate_catalog_input(self) -> "_CatalogTool":
        if self.name == "system.echo":
            value = self.input.get("message")
            valid = (
                set(self.input) == {"message"}
                and isinstance(value, str)
                and 1 <= len(value) <= 4096
            )
        elif self.name == "utility.calculator":
            value = self.input.get("expression")
            valid = (
                set(self.input) == {"expression"}
                and isinstance(value, str)
                and 1 <= len(value) <= 256
            )
        elif self.name == "utility.datetime":
            operation = self.input.get("operation")
            timezone = self.input.get("timezone")
            valid = (
                set(self.input) == {"operation", "timezone"}
                and operation in {"current_time", "current_date"}
                and isinstance(timezone, str)
                and 1 <= len(timezone) <= 64
            )
        elif self.name == "calendar.events.list":
            time_min = self.input.get("timeMin")
            time_max = self.input.get("timeMax")
            max_results = self.input.get("maxResults", 10)
            valid = (
                set(self.input).issubset({"timeMin", "timeMax", "maxResults"})
                and set(self.input).issuperset({"timeMin", "timeMax"})
                and isinstance(time_min, str)
                and isinstance(time_max, str)
                and isinstance(max_results, int)
                and not isinstance(max_results, bool)
                and 1 <= max_results <= 50
            )
        elif self.name == "calendar.events.get":
            event_id = self.input.get("eventId")
            valid = (
                set(self.input) == {"eventId"}
                and isinstance(event_id, str)
                and 1 <= len(event_id) <= 1024
            )
        else:
            summary = self.input.get("summary")
            start = self.input.get("start")
            end = self.input.get("end")
            timezone = self.input.get("timezone")
            location = self.input.get("location")
            valid = (
                set(self.input).issubset(
                    {"summary", "start", "end", "timezone", "location"}
                )
                and set(self.input).issuperset({"summary", "start", "end", "timezone"})
                and isinstance(summary, str)
                and 1 <= len(summary.strip()) <= 200
                and isinstance(start, str)
                and isinstance(end, str)
                and isinstance(timezone, str)
                and 1 <= len(timezone) <= 64
                and (location is None or isinstance(location, str))
                and (location is None or 1 <= len(location.strip()) <= 500)
            )
        if not valid:
            raise ValueError("Tool input does not match the trusted catalog")
        return self


class _ToolOutputPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["tool"]
    tool: _CatalogTool


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
                                "oneOf": [
                                    _tool_schema(item) for item in AGENT_TOOL_CATALOG
                                ]
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


def _tool_schema(capability: Mapping[str, object]) -> dict[str, object]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "name": {"const": capability["name"]},
            "input": capability["inputSchema"],
        },
        "required": ["name", "input"],
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
                input=output.plan.tool.input,
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


def _parse_deterministic_calendar_create(message: str) -> dict[str, JsonValue] | None:
    match = re.fullmatch(
        r"schedule (?P<summary>.+?) on (?P<date>\d{4}-\d{2}-\d{2}) "
        r"from (?P<start>\d{2}:\d{2}) to (?P<end>\d{2}:\d{2}) "
        r"in (?P<timezone>[A-Za-z_]+(?:/[A-Za-z_+-]+)+)",
        message,
        flags=re.IGNORECASE,
    )
    if match is None:
        return None
    try:
        zone_name = match.group("timezone")
        supported_zones = {
            "Asia/Kolkata": timezone(timedelta(hours=5, minutes=30)),
            "UTC": UTC,
        }
        zone = supported_zones[zone_name]
        start = datetime.fromisoformat(
            f"{match.group('date')}T{match.group('start')}:00"
        ).replace(tzinfo=zone)
        end = datetime.fromisoformat(
            f"{match.group('date')}T{match.group('end')}:00"
        ).replace(tzinfo=zone)
    except (KeyError, ValueError):
        return None
    if end <= start:
        return None
    return {
        "summary": match.group("summary").strip(),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "timezone": match.group("timezone"),
    }
