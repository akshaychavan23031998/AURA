import asyncio
from collections.abc import Sequence
from typing import Any, Protocol

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError


class InferenceError(Exception):
    pass


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: str
    content: str


class InferenceClient(Protocol):
    async def initialize(self) -> None: ...

    async def close(self) -> None: ...

    async def complete(
        self, messages: Sequence[ChatMessage], response_schema: dict[str, Any]
    ) -> str: ...


class _Message(BaseModel):
    content: str = Field(max_length=64 * 1024)


class _Choice(BaseModel):
    message: _Message


class _CompletionResponse(BaseModel):
    choices: list[_Choice] = Field(min_length=1, max_length=1)


class LlamaCppInferenceClient:
    def __init__(
        self,
        *,
        base_url: str,
        model_name: str,
        max_output_tokens: int,
        temperature: float,
        timeout_seconds: float,
    ) -> None:
        self._model_name = model_name
        self._max_output_tokens = max_output_tokens
        self._temperature = temperature
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=httpx.Timeout(timeout_seconds),
            limits=httpx.Limits(max_connections=1, max_keepalive_connections=1),
        )
        self._semaphore = asyncio.Semaphore(1)

    async def initialize(self) -> None:
        try:
            response = await self._client.get("/health")
            response.raise_for_status()
        except (httpx.HTTPError, ValueError) as error:
            raise InferenceError("Local inference runtime is unavailable") from error

    async def close(self) -> None:
        await self._client.aclose()

    async def complete(
        self, messages: Sequence[ChatMessage], response_schema: dict[str, Any]
    ) -> str:
        payload = {
            "model": self._model_name,
            "messages": [message.model_dump() for message in messages],
            "temperature": self._temperature,
            "max_tokens": self._max_output_tokens,
            "stream": False,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "aura_agent_plan",
                    "strict": True,
                    "schema": response_schema,
                },
            },
        }
        try:
            async with self._semaphore:
                response = await self._client.post("/v1/chat/completions", json=payload)
            response.raise_for_status()
            if len(response.content) > 128 * 1024:
                raise InferenceError("Inference response exceeded size limit")
            parsed = _CompletionResponse.model_validate(response.json())
            return parsed.choices[0].message.content
        except (httpx.HTTPError, ValueError, ValidationError) as error:
            raise InferenceError("Local inference request failed") from error
