import os
import sys
from typing import Optional


def _backend_root() -> str:
    sys_frozen = getattr(sys, "frozen", False)
    return os.path.dirname(os.path.abspath(sys.executable)) if sys_frozen else os.path.dirname(os.path.abspath(__file__))


def get_ffmpeg_bin_dir() -> str:
    return os.path.join(_backend_root(), "ffmpeg", "bin")


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
