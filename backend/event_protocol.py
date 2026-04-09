import json
from datetime import datetime
from typing import Any


EVENT_PREFIX = "__EVENT__"


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


def emit_event(name: str, action: str | None = None, payload: dict | None = None, *, event_type: str = "event") -> None:
    event = {
        "type": event_type,
        "name": name,
        "action": action,
        "payload": _safe_payload(payload or {}),
        "timestamp": datetime.now().isoformat(timespec="seconds")
    }
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
    suggestion: str | None = None
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
    emit_event("issue", action, payload)


def emit_partial_result(action: str, payload: dict) -> None:
    emit_event("partial_result", action, payload)


def emit_result(action: str, payload: dict) -> None:
    emit_event("result", action, payload, event_type="result")
