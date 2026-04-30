from __future__ import annotations


_LAST_INDEXTTS_INIT_STAGE = "not_started"


def get_last_indextts_init_stage() -> str:
    return _LAST_INDEXTTS_INIT_STAGE


def set_last_indextts_init_stage(stage_name: str) -> str:
    global _LAST_INDEXTTS_INIT_STAGE
    _LAST_INDEXTTS_INIT_STAGE = str(stage_name or "").strip() or "unknown"
    return _LAST_INDEXTTS_INIT_STAGE

