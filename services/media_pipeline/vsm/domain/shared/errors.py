from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class DomainError:
    code: str
    message: str
    category: str
    stage: str
    retryable: bool = False
    detail: str | None = None
    suggestion: str | None = None

    def to_payload(self) -> dict[str, Any]:
        payload = {
            "code": self.code,
            "message": self.message,
            "category": self.category,
            "stage": self.stage,
            "retryable": self.retryable,
        }
        if self.detail:
            payload["detail"] = self.detail
        if self.suggestion:
            payload["suggestion"] = self.suggestion
        return payload

