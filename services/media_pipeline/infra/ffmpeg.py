import os
import sys
from typing import Optional

from bootstrap.path_layout import get_media_tool_bin_dir, get_project_root


def _backend_root() -> str:
    sys_frozen = getattr(sys, "frozen", False)
    return os.path.dirname(os.path.abspath(sys.executable)) if sys_frozen else os.path.dirname(os.path.abspath(__file__))


def _get_ffmpeg_search_roots(project_root: str) -> list[str]:
    candidates = [
        os.path.join(project_root, "resources", "media_tools", "ffmpeg", "bin"),
        os.path.join(project_root, "resources", "media_tools", "ffmpeg"),
        os.path.join(project_root, "resources", "media_tools", "faster_whisper", "Faster-Whisper-XXL"),
        os.path.join(project_root, "resources", "media_tools", "faster_whisper"),
    ]
    normalized: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        absolute = os.path.abspath(candidate)
        if absolute in seen:
            continue
        seen.add(absolute)
        normalized.append(absolute)
    return normalized


def get_ffmpeg_bin_dir() -> str:
    backend_root = _backend_root()
    project_root = get_project_root(backend_root)
    default_bin = get_media_tool_bin_dir(project_root, "ffmpeg")
    executable_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    if os.path.exists(os.path.join(default_bin, executable_name)):
        return default_bin
    for candidate in _get_ffmpeg_search_roots(project_root):
        if os.path.exists(os.path.join(candidate, executable_name)):
            return candidate
    return default_bin


def resolve_ffmpeg_executable() -> str:
    ffmpeg_bin = get_ffmpeg_bin_dir()
    bundled = os.path.join(ffmpeg_bin, "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    return bundled if os.path.exists(bundled) else "ffmpeg"


def resolve_ffprobe_executable() -> str:
    ffmpeg_bin = get_ffmpeg_bin_dir()
    bundled = os.path.join(ffmpeg_bin, "ffprobe.exe" if os.name == "nt" else "ffprobe")
    return bundled if os.path.exists(bundled) else "ffprobe"


def ensure_portable_ffmpeg_in_path() -> Optional[str]:
    ffmpeg_bin = get_ffmpeg_bin_dir()
    if not os.path.exists(resolve_ffmpeg_executable()):
        return None

    current_path = os.environ.get("PATH", "")
    path_entries = current_path.split(os.pathsep) if current_path else []
    if ffmpeg_bin not in path_entries:
        os.environ["PATH"] = ffmpeg_bin + os.pathsep + current_path if current_path else ffmpeg_bin
    return ffmpeg_bin
