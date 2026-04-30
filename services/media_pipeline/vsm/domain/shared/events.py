from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class DomainEvent:
    name: str
    action: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    event_type: str = "event"
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))

