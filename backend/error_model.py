from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from event_protocol import emit_issue


@dataclass(frozen=True)
class BackendError:
    code: str
    message: str
    category: str = "system"
    stage: str | None = None
    retryable: bool = False
    detail: str | None = None
    suggestion: str | None = None

    def to_payload(self) -> dict[str, Any]:
        payload = asdict(self)
        return {key: value for key, value in payload.items() if value not in (None, "")}


def make_error(
    code: str,
    message: str,
    *,
    category: str = "system",
    stage: str | None = None,
    retryable: bool = False,
    detail: str | None = None,
    suggestion: str | None = None
) -> BackendError:
    return BackendError(
        code=code,
        message=message,
        category=category,
        stage=stage,
        retryable=retryable,
        detail=detail,
        suggestion=suggestion
    )


def error_result(error: BackendError, **extra: Any) -> dict[str, Any]:
    result = {
        "success": False,
        "error": error.message,
        "error_info": error.to_payload()
    }
    result.update(extra)
    return result


def exception_result(
    code: str,
    message: str,
    error: Exception,
    *,
    category: str = "system",
    stage: str | None = None,
    retryable: bool = False,
    suggestion: str | None = None,
    **extra: Any
) -> dict[str, Any]:
    backend_error = make_error(
        code,
        message,
        category=category,
        stage=stage,
        retryable=retryable,
        detail=str(error),
        suggestion=suggestion
    )
    return error_result(backend_error, **extra)


def emit_error_issue(
    action: str,
    error: BackendError,
    *,
    level: str = "error",
    item_index: int | None = None,
    item_total: int | None = None
) -> None:
    emit_issue(
        action,
        error.stage or "unknown",
        level,
        error.code,
        error.message,
        item_index=item_index,
        item_total=item_total,
        detail=error.detail,
        suggestion=error.suggestion,
        category=error.category,
        retryable=error.retryable
    )
