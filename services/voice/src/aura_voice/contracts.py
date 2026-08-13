from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints


class TranscriptionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str
    detected_language: str = Field(alias="detectedLanguage")
    duration_ms: float = Field(alias="durationMs")


class SynthesisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8192)
    ]
    language: Annotated[str, StringConstraints(min_length=2, max_length=35)]
