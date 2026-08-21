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

WORKFLOW_EXPORTS: dict[str, dict[str, str]] = {
    "utility.calculator": {"expression": "string", "result": "number"},
    "calendar.events.create": {"eventId": "string"},
    "calendar.events.get": {"eventId": "string"},
    "calendar.events.update": {"eventId": "string"},
    "gmail.messages.send": {"messageId": "string", "threadId": "string"},
    "gmail.messages.reply": {"messageId": "string", "threadId": "string"},
    "contacts.people.get": {"resourceName": "string"},
}
WORKFLOW_REFERENCE_DESTINATIONS: dict[str, dict[str, str]] = {
    "calendar.events.list": {"maxResults": "number"},
    "calendar.events.get": {"eventId": "string"},
    "calendar.events.update": {"eventId": "string"},
    "calendar.events.delete": {"eventId": "string"},
    "gmail.messages.reply": {"messageId": "string"},
    "gmail.messages.list": {"maxResults": "number"},
    "contacts.people.list": {"maxResults": "number"},
    "contacts.people.get": {"resourceName": "string"},
}


class WorkflowReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    from_step: WorkflowStepId = Field(alias="fromStep")
    field: Annotated[str, StringConstraints(min_length=1, max_length=64)]


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
        by_id = {step.id: step for step in self.steps}
        for step in self.steps:
            if not isinstance(step, WorkflowToolStep):
                continue
            references: list[tuple[str, WorkflowReference]] = []
            for destination, value in step.tool.input.items():
                if not isinstance(value, dict) or not (
                    "fromStep" in value or "field" in value
                ):
                    continue
                reference = WorkflowReference.model_validate(value)
                references.append((destination, reference))
            if len(references) > 8:
                raise ValueError("Too many workflow references")
            for destination, reference in references:
                source = by_id.get(reference.from_step)
                if source is None or source.id == step.id:
                    raise ValueError("Workflow reference source is invalid")
                pending = list(step.depends_on)
                ancestors: set[str] = set()
                while pending:
                    candidate = pending.pop(0)
                    if candidate in ancestors:
                        continue
                    ancestors.add(candidate)
                    pending.extend(by_id[candidate].depends_on)
                if source.id not in ancestors:
                    raise ValueError("Workflow reference source is not an ancestor")
                if not isinstance(source, WorkflowToolStep):
                    raise ValueError("Workflow reference source has no exports")
                exported = WORKFLOW_EXPORTS.get(source.tool.name, {}).get(
                    reference.field
                )
                destination_type = WORKFLOW_REFERENCE_DESTINATIONS.get(
                    step.tool.name, {}
                ).get(destination)
                if exported is None or destination_type is None:
                    raise ValueError("Workflow reference field is invalid")
                if exported != destination_type:
                    raise ValueError("Workflow reference type is incompatible")
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
