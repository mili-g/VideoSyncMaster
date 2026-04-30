from __future__ import annotations

from vsm.infra.asr.registry import AsrRegistry


def build_registry() -> AsrRegistry:
    """Build the unified ASR registry.

    Concrete provider wiring will be added incrementally during Phase 2.
    """
    return AsrRegistry()

