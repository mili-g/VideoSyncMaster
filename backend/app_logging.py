from __future__ import annotations

import builtins
import json
import logging
import sys
from typing import Any, Callable

from event_protocol import get_event_context


LOG_PREFIX = "__LOG__"
LOG_TYPES = {"business", "error", "security", "debug"}


class EventContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        context = get_event_context()
        record.trace_id = context.get("trace_id", "-")
        record.request_id = context.get("request_id", "-")
        record.action = context.get("action", "-")
        record.domain = record.name.removeprefix("videosync.")
        record.log_type = getattr(record, "log_type", _infer_log_type(record))
        return True


def _infer_log_type(record: logging.LogRecord) -> str:
    if record.levelno >= logging.ERROR:
        return "error"
    if record.levelno >= logging.WARNING:
        return "business"
    if record.levelno <= logging.DEBUG:
        return "debug"
    return "business"


class StructuredLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": self.formatTime(record, self.datefmt),
            "level": record.levelname.lower(),
            "logger": record.name,
            "domain": getattr(record, "domain", record.name),
            "log_type": getattr(record, "log_type", _infer_log_type(record)),
            "message": record.getMessage(),
            "trace_id": getattr(record, "trace_id", "-"),
            "request_id": getattr(record, "request_id", "-"),
            "action": getattr(record, "action", "-")
        }
        optional_fields = {
            "event": getattr(record, "event", None),
            "stage": getattr(record, "stage", None),
            "code": getattr(record, "code", None),
            "retryable": getattr(record, "retryable", None),
            "detail": getattr(record, "detail", None)
        }
        for key, value in optional_fields.items():
            if value not in (None, "", "-"):
                payload[key] = value
        return f"{LOG_PREFIX}{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}"


_CONFIGURED = False


def configure_logging() -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return

    handler = logging.StreamHandler(sys.stderr)
    handler.setLevel(logging.DEBUG)
    handler.addFilter(EventContextFilter())
    handler.setFormatter(StructuredLogFormatter(datefmt="%Y-%m-%d %H:%M:%S"))

    root_logger = logging.getLogger("videosync")
    root_logger.setLevel(logging.DEBUG)
    root_logger.propagate = False
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    configure_logging()
    return logging.getLogger(f"videosync.{name}")


def log_typed(
    logger: logging.Logger,
    level: int,
    log_type: str,
    message: str,
    **fields: Any
) -> None:
    normalized_log_type = log_type if log_type in LOG_TYPES else _infer_log_type(
        logging.makeLogRecord({"levelno": level, "levelname": logging.getLevelName(level)})
    )
    logger.log(level, message, extra={"log_type": normalized_log_type, **fields})


def log_business(logger: logging.Logger, level: int, message: str, **fields: Any) -> None:
    log_typed(logger, level, "business", message, **fields)


def log_error(logger: logging.Logger, message: str, **fields: Any) -> None:
    log_typed(logger, logging.ERROR, "error", message, **fields)


def log_security(logger: logging.Logger, level: int, message: str, **fields: Any) -> None:
    log_typed(logger, level, "security", message, **fields)


def log_debug(logger: logging.Logger, message: str, **fields: Any) -> None:
    log_typed(logger, logging.DEBUG, "debug", message, **fields)


def redirect_print(
    logger: logging.Logger,
    *,
    default_level: int = logging.INFO,
    fallback: Callable[..., Any] | None = None
) -> Callable[..., None]:
    fallback_print = fallback or builtins.print

    def _print(*args: Any, **kwargs: Any) -> None:
        sep = kwargs.get("sep", " ")
        end = kwargs.get("end", "\n")
        file = kwargs.get("file")

        if file not in (None, sys.stdout, sys.stderr):
            fallback_print(*args, **kwargs)
            return

        message = sep.join(str(arg) for arg in args)
        if end and end != "\n":
            message = f"{message}{end}"
        message = str(message).strip()
        if not message:
            return

        lowered = message.lower()
        if file is sys.stderr or any(token in lowered for token in ("error", "failed", "traceback", "exception", "fatal")):
            level = logging.ERROR
            log_type = "error"
        elif any(token in lowered for token in ("warn", "warning")):
            level = logging.WARNING
            log_type = "business"
        elif any(token in lowered for token in ("debug", "[reftiming]", "[ref check]")):
            level = logging.DEBUG
            log_type = "debug"
        else:
            level = default_level
            log_type = "debug" if default_level <= logging.DEBUG else "business"

        logger.log(level, message, extra={"log_type": log_type})

    return _print
