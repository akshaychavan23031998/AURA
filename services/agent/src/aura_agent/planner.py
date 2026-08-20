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
    MemoryCreatePlan,
    MemoryDeletePlan,
    MemoryReadPlan,
    MemorySearchPlan,
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
        if request.memory_context is not None:
            if not request.memory_context:
                requested_memory = _parse_deterministic_memory(request.message.strip())
                response = (
                    "I found no matching explicit saved memories."
                    if isinstance(requested_memory, MemorySearchPlan)
                    else "You have no explicit saved memories."
                )
            else:
                rendered = "; ".join(
                    f"[{item.id}] {item.kind}: {item.content}"
                    for item in request.memory_context
                )
                response = f"Your explicit saved memories are: {rendered}"
            return AgentResult(intent="respond", response=response, plan=RespondPlan())

        if request.memory_result is not None:
            result = request.memory_result
            response = (
                f"I saved that {result.memory.kind} memory with ID {result.memory.id}."
                if result.operation == "created" and result.memory is not None
                else f"I deleted memory {result.memory_id}."
            )
            return AgentResult(intent="respond", response=response, plan=RespondPlan())

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
            elif result.tool == "calendar.events.update":
                event = result.data.get("event")
                if not isinstance(event, dict) or not isinstance(
                    event.get("title"), str
                ):
                    raise ValueError("Invalid calendar update result")
                response = f"Done, {event['title']} has been updated on your calendar."
            elif result.tool == "calendar.events.delete":
                event_id = result.data.get("eventId")
                deleted = result.data.get("deleted")
                if not isinstance(event_id, str) or deleted is not True:
                    raise ValueError("Invalid calendar delete result")
                response = "Done, the calendar event has been deleted."
            elif result.tool == "gmail.messages.list":
                messages = result.data.get("messages")
                if not isinstance(messages, list):
                    raise ValueError("Invalid Gmail list result")
                response = f"I found {len(messages)} email messages."
            elif result.tool == "gmail.messages.get":
                message = result.data.get("message")
                if not isinstance(message, dict) or not isinstance(
                    message.get("subject"), str
                ):
                    raise ValueError("Invalid Gmail message result")
                response = f"The email subject is: {message['subject']}"
            elif result.tool in {"gmail.messages.send", "gmail.messages.reply"}:
                message_id = result.data.get("messageId")
                sent = result.data.get("sent")
                if not isinstance(message_id, str) or sent is not True:
                    raise ValueError("Invalid Gmail send result")
                response = (
                    "The email was sent successfully."
                    if result.tool == "gmail.messages.send"
                    else "The reply was sent successfully."
                )
            elif result.tool == "contacts.people.list":
                contacts = result.data.get("contacts")
                if not isinstance(contacts, list):
                    raise ValueError("Invalid Contacts list result")
                response = f"I found {len(contacts)} contacts."
            elif result.tool == "contacts.people.get":
                contact = result.data.get("contact")
                if not isinstance(contact, dict) or not isinstance(
                    contact.get("displayName"), str
                ):
                    raise ValueError("Invalid Contacts result")
                response = f"The contact is {contact['displayName']}."
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
        memory_plan = _parse_deterministic_memory(normalized)
        if memory_plan is not None:
            return AgentResult(
                intent=f"propose_{memory_plan.type}",
                response="I can perform that explicit memory operation.",
                plan=memory_plan,
            )
        if lowered.startswith(("forget ", "delete the saved", "remove memory")):
            return AgentResult(
                intent="respond",
                response="Please provide the exact saved memory ID to forget.",
                plan=RespondPlan(),
            )
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

        calendar_mutation = _parse_deterministic_calendar_mutation(normalized)
        if calendar_mutation is not None:
            tool_name, tool_input = calendar_mutation
            return AgentResult(
                intent="propose_tool",
                response=(
                    f"I can {tool_name.rsplit('.', 1)[-1]} that event after "
                    "your explicit approval."
                ),
                plan=ToolPlan(tool=ToolProposal(name=tool_name, input=tool_input)),
            )
        if lowered.startswith(
            ("rename calendar event", "update calendar event", "move calendar event")
        ):
            return AgentResult(
                intent="respond",
                response="Please provide the exact event ID and the requested change.",
                plan=RespondPlan(),
            )
        if lowered.startswith(("delete calendar event", "remove calendar event")):
            return AgentResult(
                intent="respond",
                response="Please provide the exact event ID to delete.",
                plan=RespondPlan(),
            )

        gmail = _parse_deterministic_gmail(normalized)
        if gmail is not None:
            tool_name, tool_input = gmail
            return AgentResult(
                intent="propose_tool",
                response=(
                    "I can perform that Gmail action after your explicit approval."
                    if tool_name in {"gmail.messages.send", "gmail.messages.reply"}
                    else "I can read that Gmail information."
                ),
                plan=ToolPlan(tool=ToolProposal(name=tool_name, input=tool_input)),
            )
        if lowered in {"read email", "get email"}:
            return AgentResult(
                intent="respond",
                response="Please provide the exact Gmail message ID.",
                plan=RespondPlan(),
            )
        if lowered.startswith("send email"):
            return AgentResult(
                intent="respond",
                response=(
                    "Please provide one exact recipient, subject, and plain-text body."
                ),
                plan=RespondPlan(),
            )
        if lowered.startswith("reply to gmail message"):
            return AgentResult(
                intent="respond",
                response="Please provide the exact Gmail message ID and reply body.",
                plan=RespondPlan(),
            )
        if lowered in {"list my contacts", "show my contacts"}:
            return AgentResult(
                intent="propose_tool",
                response="I can list your contacts.",
                plan=ToolPlan(
                    tool=ToolProposal(
                        name="contacts.people.list", input={"maxResults": 10}
                    )
                ),
            )
        contact_match = re.fullmatch(
            r"(?:get|show) contact (people/[A-Za-z0-9_-]+)",
            normalized,
            flags=re.IGNORECASE,
        )
        if contact_match is not None:
            return AgentResult(
                intent="propose_tool",
                response="I can get that contact.",
                plan=ToolPlan(
                    tool=ToolProposal(
                        name="contacts.people.get",
                        input={"resourceName": contact_match.group(1)},
                    )
                ),
            )
        if lowered.startswith(("get contact", "show contact", "find ")):
            return AgentResult(
                intent="respond",
                response="Please provide the exact Google People resource name.",
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
        "calendar.events.update",
        "calendar.events.delete",
        "gmail.messages.list",
        "gmail.messages.get",
        "gmail.messages.send",
        "gmail.messages.reply",
        "contacts.people.list",
        "contacts.people.get",
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
        elif self.name == "calendar.events.create":
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
        elif self.name == "calendar.events.update":
            event_id = self.input.get("eventId")
            allowed = {"eventId", "summary", "start", "end", "timezone", "location"}
            changes = set(self.input) - {"eventId"}
            time_fields = {"start", "end", "timezone"}
            summary = self.input.get("summary")
            location = self.input.get("location")
            valid = (
                set(self.input).issubset(allowed)
                and bool(changes)
                and isinstance(event_id, str)
                and 1 <= len(event_id.strip()) <= 1024
                and (summary is None or isinstance(summary, str))
                and (summary is None or 1 <= len(summary.strip()) <= 200)
                and (location is None or isinstance(location, str))
                and (location is None or 1 <= len(location.strip()) <= 500)
                and (
                    not changes.intersection(time_fields)
                    or time_fields.issubset(changes)
                )
                and all(
                    isinstance(self.input.get(field), str)
                    for field in changes.intersection(time_fields)
                )
            )
        elif self.name == "calendar.events.delete":
            event_id = self.input.get("eventId")
            valid = (
                set(self.input) == {"eventId"}
                and isinstance(event_id, str)
                and 1 <= len(event_id.strip()) <= 1024
            )
        elif self.name == "gmail.messages.list":
            max_results = self.input.get("maxResults", 10)
            query = self.input.get("query")
            valid = (
                set(self.input).issubset({"maxResults", "query"})
                and isinstance(max_results, int)
                and not isinstance(max_results, bool)
                and 1 <= max_results <= 20
                and (query is None or isinstance(query, str))
                and (query is None or 1 <= len(query.strip()) <= 200)
                and (query is None or ":" not in query)
            )
        elif self.name == "gmail.messages.get":
            message_id = self.input.get("messageId")
            valid = (
                set(self.input) == {"messageId"}
                and isinstance(message_id, str)
                and 1 <= len(message_id.strip()) <= 256
            )
        elif self.name == "gmail.messages.send":
            to = self.input.get("to")
            subject = self.input.get("subject")
            body = self.input.get("body")
            valid = (
                set(self.input) == {"to", "subject", "body"}
                and isinstance(to, str)
                and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", to) is not None
                and len(to) <= 320
                and "\r" not in to
                and "\n" not in to
                and isinstance(subject, str)
                and 1 <= len(subject.strip()) <= 200
                and "\r" not in subject
                and "\n" not in subject
                and isinstance(body, str)
                and 1 <= len(body) <= 20000
            )
        elif self.name == "gmail.messages.reply":
            message_id = self.input.get("messageId")
            body = self.input.get("body")
            valid = (
                set(self.input) == {"messageId", "body"}
                and isinstance(message_id, str)
                and re.fullmatch(r"[A-Za-z0-9_-]{1,256}", message_id) is not None
                and isinstance(body, str)
                and 1 <= len(body) <= 20000
            )
        elif self.name == "contacts.people.list":
            maximum = self.input.get("maxResults", 10)
            valid = (
                set(self.input).issubset({"maxResults"})
                and isinstance(maximum, int)
                and not isinstance(maximum, bool)
                and 1 <= maximum <= 25
            )
        else:
            resource_name = self.input.get("resourceName")
            valid = (
                set(self.input) == {"resourceName"}
                and isinstance(resource_name, str)
                and re.fullmatch(r"people/[A-Za-z0-9_-]+", resource_name) is not None
                and len(resource_name) <= 256
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


class _MemoryReadOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: Literal["propose_memory_read"]
    response: str = Field(min_length=1, max_length=8192)
    plan: MemoryReadPlan


class _MemorySearchOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: Literal["propose_memory_search"]
    response: str = Field(min_length=1, max_length=8192)
    plan: MemorySearchPlan


class _MemoryCreateOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: Literal["propose_memory_create"]
    response: str = Field(min_length=1, max_length=8192)
    plan: MemoryCreatePlan


class _MemoryDeleteOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: Literal["propose_memory_delete"]
    response: str = Field(min_length=1, max_length=8192)
    plan: MemoryDeletePlan


InitialOutput = (
    _RespondOutput
    | _ToolOutput
    | _MemoryReadOutput
    | _MemorySearchOutput
    | _MemoryCreateOutput
    | _MemoryDeleteOutput
)


class SelfHostedLlmPlanner:
    def __init__(self, inference: InferenceClient, model_name: str) -> None:
        self._inference = inference
        self._model_name = model_name

    async def plan(self, request: AgentRequest) -> AgentResult:
        started = time.perf_counter()
        messages = [ChatMessage(role="system", content=SYSTEM_PROMPT)]
        continuation = any(
            item is not None
            for item in (
                request.tool_result,
                request.memory_context,
                request.memory_result,
            )
        )
        if not continuation:
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
            schema = _initial_output_schema()
        else:
            continuation_data: dict[str, object] = {
                "untrustedUserMessage": request.message,
                "instruction": (
                    "Return the final response. Do not propose another action."
                ),
            }
            if request.tool_result is not None:
                continuation_data["successfulToolResultData"] = (
                    request.tool_result.model_dump(by_alias=True)
                )
            elif request.memory_context is not None:
                continuation_data["untrustedMemoryContext"] = [
                    item.model_dump(by_alias=True) for item in request.memory_context
                ]
            elif request.memory_result is not None:
                continuation_data["successfulMemoryResult"] = (
                    request.memory_result.model_dump(by_alias=True, exclude_none=True)
                )
            messages.append(
                ChatMessage(
                    role="user",
                    content=json.dumps(continuation_data, ensure_ascii=False),
                )
            )
            schema = _respond_output_schema()

        raw = await self._inference.complete(messages, schema)
        try:
            decoded = json.loads(raw)
            if not continuation:
                output = _parse_initial_output(decoded)
            else:
                output = _RespondOutput.model_validate(decoded)
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
            _memory_output_schema("memory_read"),
            _memory_output_schema("memory_search"),
            _memory_output_schema("memory_create"),
            _memory_output_schema("memory_delete"),
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


def _memory_output_schema(operation: str) -> dict[str, object]:
    plan_properties: dict[str, object] = {"type": {"const": operation}}
    required = ["type"]
    if operation == "memory_read":
        plan_properties["kind"] = {
            "type": ["string", "null"],
            "enum": ["preference", "fact", "instruction", "note", None],
        }
        required.append("kind")
    elif operation == "memory_search":
        plan_properties["query"] = {
            "type": "string",
            "minLength": 1,
            "maxLength": 1024,
        }
        required.append("query")
    elif operation == "memory_create":
        plan_properties.update(
            {
                "kind": {"enum": ["preference", "fact", "instruction", "note"]},
                "content": {"type": "string", "minLength": 1, "maxLength": 4096},
            }
        )
        required.extend(["kind", "content"])
    else:
        plan_properties["memoryId"] = {
            "type": "string",
            "pattern": "^[0-9a-f-]{36}$",
        }
        required.append("memoryId")
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "intent": {"const": f"propose_{operation}"},
            "response": {"type": "string", "minLength": 1},
            "plan": {
                "type": "object",
                "additionalProperties": False,
                "properties": plan_properties,
                "required": required,
            },
        },
        "required": ["intent", "response", "plan"],
    }


def _parse_initial_output(value: object) -> InitialOutput:
    for output_type in (
        _RespondOutput,
        _ToolOutput,
        _MemoryReadOutput,
        _MemorySearchOutput,
        _MemoryCreateOutput,
        _MemoryDeleteOutput,
    ):
        try:
            return output_type.model_validate(value)
        except ValidationError:
            pass
    raise ValueError("Invalid structured model output")


def _to_agent_result(output: InitialOutput) -> AgentResult:
    if isinstance(output, _RespondOutput):
        return AgentResult(
            intent=output.intent,
            response=output.response,
            plan=RespondPlan(),
        )
    if isinstance(output, _ToolOutput):
        plan = ToolPlan(
            tool=ToolProposal(
                name=output.plan.tool.name,
                input=output.plan.tool.input,
            )
        )
    else:
        plan = output.plan
    return AgentResult(intent=output.intent, response=output.response, plan=plan)


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


def _parse_deterministic_memory(
    message: str,
) -> MemoryReadPlan | MemorySearchPlan | MemoryCreatePlan | MemoryDeletePlan | None:
    lowered = message.casefold().strip()
    if lowered in {
        "what do you remember about me?",
        "what do you remember about me",
        "use my saved preferences",
    }:
        return MemoryReadPlan(kind=None)
    if lowered in {
        "what preferences have i asked you to remember?",
        "what preferences have i asked you to remember",
    }:
        return MemoryReadPlan(kind="preference")
    if lowered in {
        "what timezone did i ask you to remember?",
        "what timezone did i ask you to remember",
    }:
        return MemorySearchPlan(query="timezone")
    deployment_match = re.fullmatch(
        r"what did i save about ([a-z0-9][a-z0-9 -]{0,100})\??",
        lowered,
    )
    if deployment_match is not None:
        return MemorySearchPlan(query=deployment_match.group(1).strip())
    if lowered in {
        "what coding language do i prefer?",
        "what coding language do i prefer",
    }:
        return MemorySearchPlan(query="coding language preference")

    delete_match = re.fullmatch(
        r"(?:forget memory|delete (?:the )?saved "
        r"(?:preference|fact|instruction|note)(?: with id)?|"
        r"forget that saved note|remove memory) "
        r"(?P<id>[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})",
        message,
        flags=re.IGNORECASE,
    )
    if delete_match is not None:
        return MemoryDeletePlan(memoryId=delete_match.group("id").lower())

    content: str | None = None
    for pattern in (
        r"remember that (?P<content>.+)",
        r"remember (?P<content>.+)",
        r"save this:\s*(?P<content>.+)",
        r"keep in mind for future conversations that (?P<content>.+)",
    ):
        match = re.fullmatch(pattern, message, flags=re.IGNORECASE)
        if match is not None:
            content = match.group("content").strip()
            break
    if content is None or not content or len(content) > 4096:
        return None
    content_lower = content.casefold()
    if "prefer" in content_lower or "preference" in content_lower:
        kind = "preference"
    elif content_lower.startswith(("always ", "never ", "please ")):
        kind = "instruction"
    elif content_lower.startswith(("i use ", "my ", "i am ", "i work ")):
        kind = "fact"
    else:
        kind = "note"
    return MemoryCreatePlan(kind=kind, content=content)


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


def _parse_deterministic_calendar_mutation(
    message: str,
) -> (
    tuple[
        Literal["calendar.events.update", "calendar.events.delete"],
        dict[str, JsonValue],
    ]
    | None
):
    title_match = re.fullmatch(
        r"(?:rename calendar event|update calendar event) (?P<event_id>\S+) "
        r"(?:to|title to) (?P<summary>.+)",
        message,
        flags=re.IGNORECASE,
    )
    if title_match is not None:
        return (
            "calendar.events.update",
            {
                "eventId": title_match.group("event_id"),
                "summary": title_match.group("summary").strip(),
            },
        )
    move_match = re.fullmatch(
        r"move calendar event (?P<event_id>\S+) to (?P<date>\d{4}-\d{2}-\d{2}) "
        r"from (?P<start>\d{2}:\d{2}) to (?P<end>\d{2}:\d{2}) "
        r"in (?P<timezone>[A-Za-z_]+(?:/[A-Za-z_+-]+)+)",
        message,
        flags=re.IGNORECASE,
    )
    if move_match is not None:
        interval = _explicit_local_interval(move_match)
        if interval is None:
            return None
        start, end = interval
        return (
            "calendar.events.update",
            {
                "eventId": move_match.group("event_id"),
                "start": start,
                "end": end,
                "timezone": move_match.group("timezone"),
            },
        )
    delete_match = re.fullmatch(
        r"(?:delete|remove) calendar event (?P<event_id>\S+)",
        message,
        flags=re.IGNORECASE,
    )
    if delete_match is not None:
        return (
            "calendar.events.delete",
            {"eventId": delete_match.group("event_id")},
        )
    return None


def _explicit_local_interval(match: re.Match[str]) -> tuple[str, str] | None:
    try:
        zone_name = match.group("timezone")
        zone = {
            "Asia/Kolkata": timezone(timedelta(hours=5, minutes=30)),
            "UTC": UTC,
        }[zone_name]
        start = datetime.fromisoformat(
            f"{match.group('date')}T{match.group('start')}:00"
        ).replace(tzinfo=zone)
        end = datetime.fromisoformat(
            f"{match.group('date')}T{match.group('end')}:00"
        ).replace(tzinfo=zone)
    except (KeyError, ValueError):
        return None
    return None if end <= start else (start.isoformat(), end.isoformat())


def _parse_deterministic_gmail(
    message: str,
) -> (
    tuple[
        Literal[
            "gmail.messages.list",
            "gmail.messages.get",
            "gmail.messages.send",
            "gmail.messages.reply",
        ],
        dict[str, JsonValue],
    ]
    | None
):
    lowered = message.casefold()
    if lowered == "show my latest emails":
        return "gmail.messages.list", {"maxResults": 10}
    count_match = re.fullmatch(
        r"list my last (?P<count>\d{1,2}) emails", message, flags=re.IGNORECASE
    )
    if count_match is not None:
        count = int(count_match.group("count"))
        return (
            ("gmail.messages.list", {"maxResults": count}) if 1 <= count <= 20 else None
        )
    query_match = re.fullmatch(
        r"find emails about (?P<query>.+)", message, flags=re.IGNORECASE
    )
    if query_match is not None:
        query = query_match.group("query").strip()
        if 1 <= len(query) <= 200 and ":" not in query:
            return "gmail.messages.list", {"maxResults": 10, "query": query}
    get_match = re.fullmatch(
        r"(?:read|get) email (?P<message_id>[A-Za-z0-9_-]{1,256})",
        message,
        flags=re.IGNORECASE,
    )
    if get_match is not None:
        return "gmail.messages.get", {"messageId": get_match.group("message_id")}
    send_match = re.fullmatch(
        r"send email to (?P<to>\S+@\S+\.\S+) subject "
        r"(?P<subject>.+?) body (?P<body>.+)",
        message,
        flags=re.IGNORECASE,
    )
    if send_match is not None:
        return "gmail.messages.send", {
            "to": send_match.group("to"),
            "subject": send_match.group("subject").strip(),
            "body": send_match.group("body"),
        }
    reply_match = re.fullmatch(
        r"reply to gmail message (?P<message_id>[A-Za-z0-9_-]{1,256}) "
        r"with (?P<body>.+)",
        message,
        flags=re.IGNORECASE,
    )
    if reply_match is not None:
        return "gmail.messages.reply", {
            "messageId": reply_match.group("message_id"),
            "body": reply_match.group("body"),
        }
    return None
