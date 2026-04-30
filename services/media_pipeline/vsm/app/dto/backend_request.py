from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class BackendWorkerRequest:
    request_id: str
    args: list[str] = field(default_factory=list)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "BackendWorkerRequest":
        request_id = str(payload.get("id") or "")
        args = payload.get("args") or []
        if not isinstance(args, list):
            raise ValueError("Worker request args must be a list")
        normalized_args = [str(item) for item in args]
        return cls(request_id=request_id, args=normalized_args)


@dataclass(frozen=True)
class BackendWorkerResponse:
    request_id: str
    success: bool
    result: Any = None
    error: str | None = None
    error_info: dict[str, Any] | None = None

    def to_payload(self) -> dict[str, Any]:
        payload = {
            "id": self.request_id,
            "success": self.success,
        }
        if self.success:
            payload["result"] = self.result
        else:
            payload["error"] = self.error or "Unknown worker error"
            if self.error_info:
                payload["error_info"] = self.error_info
        return payload

