from __future__ import annotations

import os
from typing import Iterable

CURRENT_STRUCTURE_MARKERS = ("apps", "services", "docs")
PACKAGED_STRUCTURE_MARKERS = ("services", "resources", "models")


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
    requirements_marker = os.path.join(path, "requirements.txt")
    if not os.path.exists(requirements_marker):
        return False

    package_marker = os.path.join(path, "package.json")
    if os.path.exists(package_marker) and _has_structure_markers(path, CURRENT_STRUCTURE_MARKERS):
        return True

    return _has_structure_markers(path, PACKAGED_STRUCTURE_MARKERS)


def _has_structure_markers(path: str, markers: Iterable[str]) -> bool:
    return any(os.path.exists(os.path.join(path, marker)) for marker in markers)


def get_storage_root(project_root: str) -> str:
    storage_override = os.environ.get("VSM_STORAGE_ROOT")
    if storage_override:
        return os.path.abspath(storage_override)
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


def resolve_env_cache_dir(project_root: str) -> str:
    return get_storage_env_cache_dir(project_root)


def get_storage_runtime_dir(project_root: str) -> str:
    return os.path.join(get_storage_root(project_root), "runtime")


def get_runtime_root(project_root: str) -> str:
    runtime_override = os.environ.get("VSM_RUNTIME_ROOT")
    if runtime_override:
        return os.path.abspath(runtime_override)

    storage_runtime_dir = get_storage_runtime_dir(project_root)
    project_runtime_dir = os.path.join(project_root, "runtime")
    existing = first_existing_path(
        candidate
        for candidate in (storage_runtime_dir, project_runtime_dir)
        if os.path.isdir(candidate)
    )
    return existing or storage_runtime_dir


def get_models_root(project_root: str) -> str:
    models_override = os.environ.get("VSM_MODELS_ROOT")
    if models_override:
        return os.path.abspath(models_override)

    project_models_dir = os.path.join(project_root, "models")
    storage_models_dir = os.path.join(get_storage_root(project_root), "models")
    existing = first_existing_path(
        candidate
        for candidate in (project_models_dir, storage_models_dir)
        if os.path.isdir(candidate)
    )
    return existing or project_models_dir


def get_app_runtime_dir(project_root: str) -> str:
    return os.path.join(project_root, "runtime")


def get_runtime_overlay_dir(project_root: str, overlay_name: str) -> str:
    runtime_root = get_runtime_root(project_root)
    candidates = [
        os.path.join(runtime_root, "overlays", overlay_name),
        os.path.join(get_storage_runtime_dir(project_root), "overlays", overlay_name),
        os.path.join(get_app_runtime_dir(project_root), "overlays", overlay_name),
    ]
    return first_existing_path(candidates) or candidates[0]


def get_runtime_python_dir(project_root: str) -> str:
    runtime_root = get_runtime_root(project_root)
    candidates = [
        os.path.join(runtime_root, "python"),
        os.path.join(get_storage_runtime_dir(project_root), "python"),
        os.path.join(project_root, "runtime", "python"),
        os.path.join(project_root, "python"),
    ]
    existing = first_existing_path(candidate for candidate in candidates if os.path.isdir(candidate))
    return existing or candidates[0]


def resolve_portable_python(project_root: str) -> str:
    python_dir = get_runtime_python_dir(project_root)
    return os.path.join(python_dir, "python.exe")


def get_media_tool_root(project_root: str, tool_name: str) -> str:
    return os.path.join(project_root, "resources", "media_tools", tool_name)


def get_media_tool_bin_dir(project_root: str, tool_name: str) -> str:
    return os.path.join(get_media_tool_root(project_root, tool_name), "bin")


def get_faster_whisper_runtime_search_roots(
    project_root: str,
    *,
    backend_dir: str | None = None,
    extra_root: str | None = None,
) -> list[str]:
    models_root = get_models_root(project_root)
    candidates = [
        extra_root,
        os.path.join(models_root, "faster_whisper_runtime"),
        os.path.join(get_storage_root(project_root), "models", "faster_whisper_runtime"),
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
