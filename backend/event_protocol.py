import json
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime
from typing import Any


EVENT_PREFIX = "__EVENT__"
_EVENT_CONTEXT: ContextVar[dict[str, Any]] = ContextVar("_EVENT_CONTEXT", default={})


def _safe_payload(payload: Any) -> Any:
    try:
        json.dumps(payload, ensure_ascii=False)
        return payload
    except TypeError:
        if isinstance(payload, dict):
            return {str(key): _safe_payload(value) for key, value in payload.items()}
        if isinstance(payload, (list, tuple)):
            return [_safe_payload(item) for item in payload]
        return str(payload)


def get_event_context() -> dict[str, Any]:
    current = _EVENT_CONTEXT.get() or {}
    return dict(current)


def set_event_context(**values: Any) -> None:
    current = get_event_context()
    for key, value in values.items():
        if value in (None, ""):
            current.pop(key, None)
        else:
            current[key] = value
    _EVENT_CONTEXT.set(current)


def clear_event_context() -> None:
    _EVENT_CONTEXT.set({})


@contextmanager
def scoped_event_context(**values: Any):
    token = _EVENT_CONTEXT.set({**get_event_context(), **{k: v for k, v in values.items() if v not in (None, "")}})
    try:
        yield
    finally:
        _EVENT_CONTEXT.reset(token)


def emit_event(name: str, action: str | None = None, payload: dict | None = None, *, event_type: str = "event") -> None:
    event = {
        "type": event_type,
        "name": name,
        "action": action,
        "payload": _safe_payload(payload or {}),
        "timestamp": datetime.now().isoformat(timespec="seconds")
    }
    context = get_event_context()
    if context:
        event["context"] = _safe_payload(context)
    print(f"{EVENT_PREFIX}{json.dumps(event, ensure_ascii=False, separators=(',', ':'))}", flush=True)


def emit_progress(
    action: str,
    stage: str,
    percent: int | float,
    message: str = "",
    *,
    stage_label: str | None = None,
    item_index: int | None = None,
    item_total: int | None = None,
    detail: str | None = None
) -> None:
    payload = {
        "stage": stage,
        "stage_label": stage_label or stage,
        "percent": max(0, min(int(percent), 100)),
        "message": message
    }
    if item_index is not None:
        payload["item_index"] = item_index
    if item_total is not None:
        payload["item_total"] = item_total
    if detail:
        payload["detail"] = detail
    emit_event("progress", action, payload)


def emit_stage(
    action: str,
    stage: str,
    message: str = "",
    *,
    status: str = "running",
    stage_label: str | None = None,
    detail: str | None = None
) -> None:
    payload = {
        "stage": stage,
        "stage_label": stage_label or stage,
        "status": status,
        "message": message
    }
    if detail:
        payload["detail"] = detail
    emit_event("stage", action, payload)


def emit_issue(
    action: str,
    stage: str,
    level: str,
    code: str,
    message: str,
    *,
    item_index: int | None = None,
    item_total: int | None = None,
    detail: str | None = None,
    suggestion: str | None = None,
    category: str | None = None,
    retryable: bool | None = None
) -> None:
    payload = {
        "stage": stage,
        "level": level,
        "code": code,
        "message": message
    }
    if item_index is not None:
        payload["item_index"] = item_index
    if item_total is not None:
        payload["item_total"] = item_total
    if detail:
        payload["detail"] = detail
    if suggestion:
        payload["suggestion"] = suggestion
    if category:
        payload["category"] = category
    if retryable is not None:
        payload["retryable"] = retryable
    emit_event("issue", action, payload)


def emit_partial_result(action: str, payload: dict) -> None:
    emit_event("partial_result", action, payload)


def emit_result(action: str, payload: dict) -> None:
    emit_event("result", action, payload, event_type="result")
