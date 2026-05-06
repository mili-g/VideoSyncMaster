import os
import sys
from typing import Optional

import ffmpeg as ffmpeg_python

from bootstrap.path_layout import get_media_tool_bin_dir, get_project_root


def _backend_root() -> str:
    sys_frozen = getattr(sys, "frozen", False)
    return os.path.dirname(os.path.abspath(sys.executable)) if sys_frozen else os.path.dirname(os.path.abspath(__file__))


def get_ffmpeg_bin_dir() -> str:
    backend_root = _backend_root()
    project_root = get_project_root(backend_root)
    return get_media_tool_bin_dir(project_root, "ffmpeg")


def resolve_ffmpeg_executable() -> str:
    ffmpeg_bin = get_ffmpeg_bin_dir()
    bundled = os.path.join(ffmpeg_bin, "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    return bundled if os.path.exists(bundled) else "ffmpeg"


def resolve_ffprobe_executable() -> str:
    ffmpeg_bin = get_ffmpeg_bin_dir()
    bundled = os.path.join(ffmpeg_bin, "ffprobe.exe" if os.name == "nt" else "ffprobe")
    return bundled if os.path.exists(bundled) else "ffprobe"


def run_ffmpeg(stream, *args, **kwargs):
    kwargs.setdefault("cmd", resolve_ffmpeg_executable())
    return stream.run(*args, **kwargs)


def probe_media(*args, **kwargs):
    kwargs.setdefault("cmd", resolve_ffprobe_executable())
    return ffmpeg_python.probe(*args, **kwargs)


def ensure_portable_ffmpeg_in_path() -> Optional[str]:
    ffmpeg_bin = get_ffmpeg_bin_dir()
    ffmpeg_executable = resolve_ffmpeg_executable()
    if not os.path.exists(ffmpeg_executable):
        return None

    current_path = os.environ.get("PATH", "")
    path_entries = current_path.split(os.pathsep) if current_path else []
    if ffmpeg_bin not in path_entries:
        os.environ["PATH"] = ffmpeg_bin + os.pathsep + current_path if current_path else ffmpeg_bin
    _configure_pydub_audio_tools()
    return ffmpeg_bin


def _configure_pydub_audio_tools() -> None:
    try:
        from pydub import AudioSegment
    except Exception:
        return

    ffmpeg_executable = resolve_ffmpeg_executable()
    ffprobe_executable = resolve_ffprobe_executable()

    if os.path.exists(ffmpeg_executable):
        AudioSegment.converter = ffmpeg_executable
        AudioSegment.ffmpeg = ffmpeg_executable
    if os.path.exists(ffprobe_executable):
        AudioSegment.ffprobe = ffprobe_executable
