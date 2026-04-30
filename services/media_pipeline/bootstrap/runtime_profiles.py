from __future__ import annotations

from .dependency_runtime import PROFILE_INDEX_TTS, PROFILE_QWEN3


RUNTIME_PROFILE_VERSION_MAP = {
    "auto": None,
    "current": None,
    "qwen3": PROFILE_QWEN3,
    "qwen": PROFILE_QWEN3,
    "indextts": PROFILE_INDEX_TTS,
    "index-tts": PROFILE_INDEX_TTS,
}


def normalize_runtime_profile(value: str | None) -> str:
    normalized = str(value or "auto").strip().lower()
    return normalized or "auto"


def resolve_runtime_profile_version(profile: str | None) -> str | None:
    normalized = normalize_runtime_profile(profile)
    if normalized in RUNTIME_PROFILE_VERSION_MAP:
        return RUNTIME_PROFILE_VERSION_MAP[normalized]
    return normalized if normalized.replace(".", "").isdigit() else None


def infer_runtime_profile(*, tts_service: str | None = None, asr_service: str | None = None, requested_profile: str | None = None) -> str:
    normalized = normalize_runtime_profile(requested_profile)
    if normalized not in {"", "auto", "current"}:
        return normalized

    if tts_service:
        service_key = str(tts_service).strip().lower()
        if service_key == "indextts":
            return "indextts"
        if service_key == "qwen":
            return "qwen3"

    if asr_service:
        service_key = str(asr_service).strip().lower()
        if service_key == "qwen":
            return service_key

    return "current"
