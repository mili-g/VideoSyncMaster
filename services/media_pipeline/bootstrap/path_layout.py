from __future__ import annotations

import os
from typing import Iterable

CURRENT_STRUCTURE_MARKERS = ("apps", "services", "docs")
LEGACY_STRUCTURE_MARKERS = ("ui", "backend")


def first_existing_path(candidates: Iterable[str]) -> str | None:
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    return None


def get_project_root(current_dir: str) -> str:
    current = os.path.abspath(current_dir)
    for candidate in [current, *list(_parent_chain(current, depth=5))]:
        if _looks_like_project_root(candidate):
            return candidate
    return os.path.abspath(os.path.join(current_dir, ".."))


def _parent_chain(path: str, depth: int) -> Iterable[str]:
    current = os.path.abspath(path)
    for _ in range(max(0, depth)):
        current = os.path.dirname(current)
        yield current


def _looks_like_project_root(path: str) -> bool:
    required_markers = [
        os.path.join(path, "package.json"),
        os.path.join(path, "requirements.txt"),
    ]
    if not all(os.path.exists(marker) for marker in required_markers):
        return False

    if _has_structure_markers(path, CURRENT_STRUCTURE_MARKERS):
        return True
    return _has_structure_markers(path, LEGACY_STRUCTURE_MARKERS)


def _has_structure_markers(path: str, markers: Iterable[str]) -> bool:
    return any(os.path.exists(os.path.join(path, marker)) for marker in markers)


def get_storage_root(project_root: str) -> str:
    candidate = os.path.join(project_root, "storage")
    return candidate if os.path.isdir(candidate) else project_root


def get_storage_logs_dir(project_root: str) -> str:
    return os.path.join(get_storage_root(project_root), "logs")


def get_storage_output_dir(project_root: str) -> str:
    return os.path.join(get_storage_root(project_root), "output")


def get_storage_cache_dir(project_root: str) -> str:
    return os.path.join(get_storage_root(project_root), "cache")


def get_storage_env_cache_dir(project_root: str) -> str:
    return os.path.join(get_storage_cache_dir(project_root), "env")


def get_legacy_env_cache_dir(project_root: str) -> str:
    return os.path.join(project_root, ".env_cache")


def resolve_env_cache_dir(project_root: str) -> str:
    storage_env_cache = get_storage_env_cache_dir(project_root)
    legacy_env_cache = get_legacy_env_cache_dir(project_root)
    if os.path.isdir(storage_env_cache):
        return storage_env_cache
    if os.path.isdir(legacy_env_cache):
        return legacy_env_cache
    return storage_env_cache


def get_storage_runtime_dir(project_root: str) -> str:
    return os.path.join(get_storage_root(project_root), "runtime")


def get_app_runtime_dir(project_root: str) -> str:
    return os.path.join(project_root, "runtime")


def get_runtime_overlay_dir(project_root: str, overlay_name: str) -> str:
    return os.path.join(get_app_runtime_dir(project_root), "overlays", overlay_name)


def get_runtime_python_dir(project_root: str) -> str:
    candidate = os.path.join(project_root, "runtime", "python")
    if os.path.isdir(candidate):
        return candidate
    return os.path.join(project_root, "python")


def resolve_portable_python(project_root: str) -> str:
    python_dir = get_runtime_python_dir(project_root)
    return os.path.join(python_dir, "python.exe")


def get_media_tool_root(project_root: str, tool_name: str) -> str:
    candidates = [
        os.path.join(project_root, "resources", "media_tools", tool_name),
        os.path.join(project_root, "backend", tool_name),
    ]
    if tool_name == "ffmpeg":
        for candidate in candidates:
            if not os.path.isdir(candidate):
                continue
            candidate_bin = os.path.join(candidate, "bin")
            if os.path.exists(os.path.join(candidate_bin, "ffmpeg.exe")) or os.path.exists(os.path.join(candidate_bin, "ffprobe.exe")):
                return candidate
            if os.path.exists(os.path.join(candidate, "ffmpeg.exe")) or os.path.exists(os.path.join(candidate, "ffprobe.exe")):
                return candidate
    return first_existing_path(candidates) or candidates[0]


def get_media_tool_bin_dir(project_root: str, tool_name: str) -> str:
    tool_root = get_media_tool_root(project_root, tool_name)
    bin_dir = os.path.join(tool_root, "bin")
    if tool_name == "ffmpeg":
        if os.path.exists(os.path.join(bin_dir, "ffmpeg.exe")) or os.path.exists(os.path.join(bin_dir, "ffprobe.exe")):
            return bin_dir
        if os.path.exists(os.path.join(tool_root, "ffmpeg.exe")) or os.path.exists(os.path.join(tool_root, "ffprobe.exe")):
            return tool_root
    return bin_dir


def get_faster_whisper_runtime_search_roots(
    project_root: str,
    *,
    backend_dir: str | None = None,
    legacy_project_root: str | None = None,
    extra_root: str | None = None,
) -> list[str]:
    candidates = [
        extra_root,
        os.path.join(project_root, "models", "faster_whisper_runtime"),
        os.path.join(project_root, "resources", "media_tools", "faster_whisper"),
        os.path.join(project_root, "resources", "media_tools"),
        os.path.join(project_root, "resources"),
        project_root,
    ]

    if backend_dir:
        backend_parent = os.path.dirname(os.path.abspath(backend_dir))
        candidates.extend(
            [
                os.path.abspath(backend_dir),
                backend_parent,
                os.path.join(backend_parent, "models", "faster_whisper_runtime"),
                os.path.join(backend_parent, "bin"),
                os.path.join(backend_parent, "tools"),
                os.path.join(backend_parent, "resources"),
                os.path.join(backend_parent, "resources", "media_tools"),
                os.path.join(backend_parent, "resources", "media_tools", "faster_whisper"),
            ]
        )

    if legacy_project_root:
        candidates.extend(
            [
                os.path.join(legacy_project_root, "models", "faster_whisper_runtime"),
                os.path.join(legacy_project_root, "resources"),
                os.path.join(legacy_project_root, "resources", "media_tools"),
                os.path.join(legacy_project_root, "resources", "media_tools", "faster_whisper"),
                os.path.join(legacy_project_root, "resource", "bin"),
                os.path.join(legacy_project_root, "resource", "bin", "Faster-Whisper-XXL"),
                os.path.join(legacy_project_root, "resource", "bin", "Faster-Whisper-XXL", "Faster-Whisper-XXL"),
            ]
        )

    normalized: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate:
            continue
        absolute = os.path.abspath(candidate)
        if absolute in seen:
            continue
        seen.add(absolute)
        normalized.append(absolute)
    return normalized
