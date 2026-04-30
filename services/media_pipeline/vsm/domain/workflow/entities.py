from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


WorkflowPhase = Literal[
    "bootstrap",
    "preprocess",
    "asr",
    "translation",
    "dubbing",
    "merge",
    "completed",
    "failed",
]

SegmentStatus = Literal["pending", "ready", "error", "skipped"]


@dataclass(frozen=True)
class SubtitleSegment:
    index: int
    start: float
    end: float
    text: str
    words: list[dict[str, Any]] = field(default_factory=list)
    source_language: str | None = None

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    def validate(self) -> None:
        if self.index < 0:
            raise ValueError("Segment index must be non-negative")
        if self.end < self.start:
            raise ValueError("Segment end must be greater than or equal to start")
        if not self.text.strip():
            raise ValueError("Segment text must not be empty")

    def to_payload(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "start": self.start,
            "end": self.end,
            "duration": self.duration,
            "text": self.text,
            "words": list(self.words),
            "source_language": self.source_language,
        }


@dataclass(frozen=True)
class TranslatedSegment(SubtitleSegment):
    translated_text: str = ""
    target_language: str | None = None
    duration_budget: float | None = None

    def is_readable(self) -> bool:
        return bool(self.translated_text.strip())

    def to_payload(self) -> dict[str, Any]:
        payload = super().to_payload()
        payload.update(
            {
                "translated_text": self.translated_text,
                "target_language": self.target_language,
                "duration_budget": self.duration_budget if self.duration_budget is not None else self.duration,
            }
        )
        return payload


@dataclass(frozen=True)
class DubSegment:
    index: int
    audio_path: str | None = None
    duration: float | None = None
    status: SegmentStatus = "pending"
    error_info: dict[str, Any] | None = None

    def can_retry(self) -> bool:
        return self.status == "error"

    def is_ready(self) -> bool:
        return self.status == "ready" and bool(self.audio_path)

    def to_payload(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "audio_path": self.audio_path,
            "duration": self.duration,
            "status": self.status,
            "error_info": self.error_info,
        }


@dataclass(frozen=True)
class SessionArtifact:
    kind: str
    path: str
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "path": self.path,
            "metadata": dict(self.metadata),
        }


@dataclass(frozen=True)
class ProcessingSession:
    session_key: str
    phase: WorkflowPhase
    current_stage: str
    recoverable: bool = True
    artifacts: list[SessionArtifact] = field(default_factory=list)
    last_error: dict[str, Any] | None = None

    def add_artifact(self, artifact: SessionArtifact) -> "ProcessingSession":
        return ProcessingSession(
            session_key=self.session_key,
            phase=self.phase,
            current_stage=self.current_stage,
            recoverable=self.recoverable,
            artifacts=[*self.artifacts, artifact],
            last_error=self.last_error,
        )

    def mark_failed(self, error_info: dict[str, Any]) -> "ProcessingSession":
        return ProcessingSession(
            session_key=self.session_key,
            phase="failed",
            current_stage=self.current_stage,
            recoverable=self.recoverable,
            artifacts=list(self.artifacts),
            last_error=dict(error_info),
        )

    def to_payload(self) -> dict[str, Any]:
        return {
            "session_key": self.session_key,
            "phase": self.phase,
            "current_stage": self.current_stage,
            "recoverable": self.recoverable,
            "artifacts": [artifact.to_payload() for artifact in self.artifacts],
            "last_error": self.last_error,
        }
