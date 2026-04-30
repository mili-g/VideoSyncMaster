from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol


ProviderType = Literal["local", "api"]


@dataclass(frozen=True)
class AsrSegment:
    start: float
    end: float
    text: str
    words: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class AsrModelProfile:
    profile_id: str
    model_id: str
    model_path: str | None = None
    device_policy: str = "auto"
    batch_policy: str = "default"
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AsrCapability:
    provider_id: str
    provider_type: ProviderType
    display_name: str
    supported_languages: list[str] = field(default_factory=list)
    supports_word_timestamps: bool = False
    supports_streaming: bool = False
    runtime_id: str = "asr-runtime"
    profiles: list[AsrModelProfile] = field(default_factory=list)


@dataclass(frozen=True)
class AsrTaskRequest:
    audio_path: str
    language: str | None = None
    enable_chunking: bool = True
    need_word_timestamps: bool = False
    prompt: str = ""
    provider_options: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AsrTaskResult:
    provider_id: str
    segments: list[AsrSegment]
    language: str | None = None
    raw_metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CapabilityHealth:
    healthy: bool
    message: str = ""
    detail: str = ""


class AsrProvider(Protocol):
    provider_id: str
    provider_type: ProviderType

    def health_check(self) -> CapabilityHealth:
        ...

    def describe_capability(self) -> AsrCapability:
        ...

    def transcribe(self, request: AsrTaskRequest) -> AsrTaskResult:
        ...

