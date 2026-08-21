from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    model_validator,
)

Message = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8192)
]


class ToolExecutionResultContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool: str
    status: Literal["success"]
    data: dict[str, JsonValue]


MemoryKind = Literal["preference", "fact", "instruction", "note"]


class MemoryContextItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Annotated[str, StringConstraints(pattern=r"^[0-9a-f-]{36}$")]
    kind: MemoryKind
    content: Annotated[str, StringConstraints(min_length=1, max_length=4096)]


class MemoryMutationResultContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation: Literal["created", "deleted"]
    memory: MemoryContextItem | None = None
    memory_id: Annotated[str, StringConstraints(pattern=r"^[0-9a-f-]{36}$")] | None = (
        Field(default=None, alias="memoryId")
    )

    @model_validator(mode="after")
    def validate_operation_shape(self) -> "MemoryMutationResultContext":
        valid = (
            self.operation == "created"
            and self.memory is not None
            and self.memory_id is None
        ) or (
            self.operation == "deleted"
            and self.memory is None
            and self.memory_id is not None
        )
        if not valid:
            raise ValueError("Invalid memory result")
        return self


class KnowledgeContextItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reference: Annotated[
        str, StringConstraints(pattern=r"^K[1-9][0-9]?$", max_length=3)
    ]
    title: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    content: Annotated[str, StringConstraints(min_length=1, max_length=2000)]
    ordinal: Annotated[int, Field(ge=0, le=127)]


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
    memory_context: Annotated[list[MemoryContextItem], Field(max_length=10)] | None = (
        Field(default=None, alias="memoryContext")
    )
    memory_result: MemoryMutationResultContext | None = Field(
        default=None, alias="memoryResult"
    )
    knowledge_context: (
        Annotated[list[KnowledgeContextItem], Field(min_length=1, max_length=10)] | None
    ) = Field(default=None, alias="knowledgeContext")

    @model_validator(mode="after")
    def validate_single_continuation(self) -> "AgentRequest":
        continuations = (
            self.tool_result,
            self.memory_context,
            self.memory_result,
            self.knowledge_context,
        )
        if sum(item is not None for item in continuations) > 1:
            raise ValueError("Only one continuation context is allowed")
        return self


class ToolProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    input: dict[str, JsonValue]


class RespondPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["respond"] = "respond"


class ToolPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["tool"] = "tool"
    tool: ToolProposal


class MemoryReadPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["memory_read"] = "memory_read"
    kind: MemoryKind | None = None


class MemorySearchPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["memory_search"] = "memory_search"
    query: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1024)
    ]


class MemoryCreatePlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["memory_create"] = "memory_create"
    kind: MemoryKind
    content: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4096)
    ]


class MemoryDeletePlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["memory_delete"] = "memory_delete"
    memory_id: Annotated[str, StringConstraints(pattern=r"^[0-9a-f-]{36}$")] = Field(
        alias="memoryId"
    )


class KnowledgeSearchPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["knowledge_search"] = "knowledge_search"
    query: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=1024,
            pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]+$",
        ),
    ]


WorkflowStepId = Annotated[
    str, StringConstraints(pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,63}$", max_length=64)
]
WorkflowDependencies = Annotated[list[WorkflowStepId], Field(max_length=7)]


class WorkflowToolStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: WorkflowStepId
    kind: Literal["tool"]
    depends_on: WorkflowDependencies = Field(alias="dependsOn")
    tool: ToolProposal


class WorkflowMemoryReadStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: WorkflowStepId
    kind: Literal["memory_read"]
    depends_on: WorkflowDependencies = Field(alias="dependsOn")
    memory_kind: MemoryKind | None = Field(default=None, alias="memoryKind")


class WorkflowMemorySearchStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: WorkflowStepId
    kind: Literal["memory_search"]
    depends_on: WorkflowDependencies = Field(alias="dependsOn")
    query: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1024)
    ]


class WorkflowKnowledgeSearchStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: WorkflowStepId
    kind: Literal["knowledge_search"]
    depends_on: WorkflowDependencies = Field(alias="dependsOn")
    query: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=1024,
            pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]+$",
        ),
    ]


WorkflowStep = Annotated[
    WorkflowToolStep
    | WorkflowMemoryReadStep
    | WorkflowMemorySearchStep
    | WorkflowKnowledgeSearchStep,
    Field(discriminator="kind"),
]


class WorkflowPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["workflow"] = "workflow"
    goal: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=1024,
            pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]+$",
        ),
    ]
    steps: Annotated[list[WorkflowStep], Field(min_length=1, max_length=8)]

    @model_validator(mode="after")
    def validate_dag(self) -> "WorkflowPlan":
        identifiers = [step.id for step in self.steps]
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("Duplicate workflow step ID")
        known = set(identifiers)
        dependencies: dict[str, set[str]] = {}
        for step in self.steps:
            if len(set(step.depends_on)) != len(step.depends_on):
                raise ValueError("Duplicate workflow dependency")
            if step.id in step.depends_on:
                raise ValueError("Workflow step cannot depend on itself")
            if any(item not in known for item in step.depends_on):
                raise ValueError("Workflow dependency is missing")
            dependencies[step.id] = set(step.depends_on)
        ready = [
            identifier for identifier in identifiers if not dependencies[identifier]
        ]
        visited: set[str] = set()
        while ready:
            identifier = ready.pop(0)
            if identifier in visited:
                continue
            visited.add(identifier)
            for candidate in identifiers:
                dependencies[candidate].discard(identifier)
                if not dependencies[candidate] and candidate not in visited:
                    ready.append(candidate)
        if len(visited) != len(identifiers):
            raise ValueError("Workflow contains a cycle")
        return self


Plan = Annotated[
    RespondPlan
    | ToolPlan
    | MemoryReadPlan
    | MemorySearchPlan
    | MemoryCreatePlan
    | MemoryDeletePlan
    | KnowledgeSearchPlan
    | WorkflowPlan,
    Field(discriminator="type"),
]


class AgentResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: str
    response: str
    plan: Plan
    citation_ids: (
        Annotated[
            list[
                Annotated[
                    str,
                    StringConstraints(pattern=r"^K[1-9][0-9]?$", max_length=3),
                ]
            ],
            Field(max_length=10),
        ]
        | None
    ) = Field(
        default=None,
        alias="citationIds",
        exclude_if=lambda value: value is None,
    )


class AgentResponse(AgentResult):
    request_id: str = Field(alias="requestId")
