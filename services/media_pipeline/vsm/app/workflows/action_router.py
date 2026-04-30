from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable


@dataclass(frozen=True)
class WorkflowExecutionContext:
    action: str
    args: Any


@dataclass(frozen=True)
class WorkflowCommand:
    name: str
    handler: Callable[[], Any]
    description: str = ""


class ActionRouter:
    """Command-style router for gradually migrating legacy action handling."""

    def __init__(
        self,
        *,
        pre_dispatch: Callable[[], tuple[bool, Any]],
        commands: dict[str, Callable[[], Any]] | Iterable[WorkflowCommand],
        known_actions: Iterable[str] | None = None,
    ) -> None:
        self._pre_dispatch = pre_dispatch
        if isinstance(commands, dict):
            self._commands = dict(commands)
        else:
            self._commands = {command.name: command.handler for command in commands}
        self._known_actions = set(known_actions or [])
        self._known_actions.update(self._commands.keys())

    def dispatch(self, context: WorkflowExecutionContext) -> Any:
        handled, basic_result = self._pre_dispatch()
        if handled:
            return basic_result

        command = self._commands.get(context.action)
        return command() if command else None

    def has_command(self, action: str) -> bool:
        return action in self._known_actions

    def list_commands(self) -> list[str]:
        return sorted(self._known_actions)
