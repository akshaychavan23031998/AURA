from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StringConstraints

Message = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8192)
]


class ToolExecutionResultContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool: str
    status: Literal["success"]
    data: dict[str, JsonValue]


class AgentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: Message
    conversation_id: (
        Annotated[str, StringConstraints(min_length=1, max_length=128)] | None
    ) = Field(default=None, alias="conversationId")
    locale: (
        Annotated[
            str,
            StringConstraints(
                pattern=r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$", max_length=35
            ),
        ]
        | None
    ) = None
    tool_result: ToolExecutionResultContext | None = Field(
        default=None, alias="toolResult"
    )


class ToolProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    input: dict[str, JsonValue]


class RespondPlan(BaseModel):
    type: Literal["respond"] = "respond"


class ToolPlan(BaseModel):
    type: Literal["tool"] = "tool"
    tool: ToolProposal


Plan = Annotated[RespondPlan | ToolPlan, Field(discriminator="type")]


class AgentResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: str
    response: str
    plan: Plan


class AgentResponse(AgentResult):
    request_id: str = Field(alias="requestId")
