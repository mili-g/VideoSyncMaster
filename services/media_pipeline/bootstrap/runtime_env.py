from __future__ import annotations

import builtins
import logging
import os
import subprocess
import sys
from typing import Callable

from bootstrap.path_layout import get_media_tool_bin_dir, get_project_root, get_storage_logs_dir, resolve_portable_python
from infra.logging import log_business, log_error, log_security


MAX_LOG_FILE_BYTES = 2 * 1024 * 1024
LOG_TAIL_BYTES = 256 * 1024


def configure_stdio_utf8() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")


def apply_base_environment() -> None:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["PYTHONUTF8"] = "1"
    os.environ["PYTHONIOENCODING"] = "utf-8"
    os.environ["NUMBA_DISABLE_INTEL_SVML"] = "1"
    os.environ["NUMBA_CPU_NAME"] = "generic"


def patch_subprocess_encoding() -> None:
    if getattr(subprocess.Popen, "__name__", "") == "EncodingSafePopen":
        return

    original_popen = subprocess.Popen

    class EncodingSafePopen(original_popen):
        def __init__(self, *args, **kwargs):
            text_mode = (
                kwargs.get("text")
                or kwargs.get("universal_newlines")
                or (kwargs.get("encoding") is not None)
            )
            if text_mode:
                kwargs.setdefault("encoding", "utf-8")
                kwargs.setdefault("errors", "replace")
            super().__init__(*args, **kwargs)

    subprocess.Popen = EncodingSafePopen


def resolve_runtime_context(current_file: str) -> tuple[str, str, bool]:
    current_dir = os.path.dirname(os.path.abspath(current_file))
    app_root = get_project_root(current_dir)
    is_prod = os.path.exists(os.path.join(app_root, "resources", "app.asar")) or getattr(sys, "frozen", False)
    return current_dir, app_root, is_prod


def create_debug_logger(log_file: str) -> Callable[[str], None]:
    def debug_log(message: str) -> None:
        try:
            with open(log_file, "a", encoding="utf-8") as handle:
                import datetime
                timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                handle.write(f"[{timestamp}] {message}\n")
        except Exception:
            builtins.print(f"Log Error: {message}", file=sys.stderr)

    return debug_log


def initialize_debug_log(app_root: str, is_prod: bool) -> tuple[str, Callable[[str], None]]:
    log_dir = get_storage_logs_dir(app_root)
    log_file = os.path.join(log_dir, "backend_debug.log")

    try:
        os.makedirs(log_dir, exist_ok=True)
        if os.path.exists(log_file):
            current_size = os.path.getsize(log_file)
            if current_size > MAX_LOG_FILE_BYTES:
                with open(log_file, "rb") as src:
                    src.seek(max(0, current_size - LOG_TAIL_BYTES))
                    tail = src.read()
                with open(log_file, "wb") as dst:
                    dst.write(tail)
        debug_log = create_debug_logger(log_file)
        debug_log("Backend starting...")
        debug_log(f"Executable: {sys.executable}")
        debug_log(f"CWD: {os.getcwd()}")
        debug_log(f"App Root: {app_root}")
        debug_log(f"Is Prod: {is_prod}")
        return log_file, debug_log
    except Exception as error:
        builtins.print(f"Logging setup failed: {error}", file=sys.stderr)

        def fallback_debug_log(message: str) -> None:
            builtins.print(f"[LOG_FAIL] {message}", file=sys.stderr)

        return log_file, fallback_debug_log


def install_exception_hook(debug_log: Callable[[str], None]) -> None:
    def exception_hook(exc_type, exc_value, exc_traceback):
        import traceback
        error_msg = "".join(traceback.format_exception(exc_type, exc_value, exc_traceback))
        try:
            debug_log(f"UNHANDLED EXCEPTION:\n{error_msg}")
        except Exception:
            pass
        sys.__excepthook__(exc_type, exc_value, exc_traceback)

    sys.excepthook = exception_hook


class DualWriter:
    def __init__(self, file_path: str, original_stream):
        self.file = open(file_path, "a", encoding="utf-8", buffering=1)
        self.original_stream = original_stream

    def write(self, message):
        try:
            self.file.write(message)
            self.original_stream.write(message)
            self.original_stream.flush()
        except Exception:
            pass

    def flush(self):
        try:
            self.file.flush()
            self.original_stream.flush()
        except Exception:
            pass


def enable_stream_tee(log_file: str) -> None:
    if os.environ.get("VSM_BACKEND_TEE_LOG", "0") != "1":
        return
    sys.stdout = DualWriter(log_file, sys.stdout)
    sys.stderr = DualWriter(log_file, sys.stderr)


def enforce_portable_python(app_root: str, current_file: str, logger: logging.Logger) -> None:
    if getattr(sys, "frozen", False):
        return

    try:
        portable_python = resolve_portable_python(app_root)
        if not os.path.exists(portable_python):
            return

        target_py = os.path.abspath(portable_python).lower()
        current_py = sys.executable.lower()
        if target_py == current_py:
            return

        log_security(
            logger,
            logging.WARNING,
            "Relaunching with portable python",
            event="python_relaunch",
            stage="bootstrap",
            detail=target_py,
        )
        ret = subprocess.call([target_py, current_file, *sys.argv[1:]], env=os.environ.copy())
        sys.exit(ret)
    except Exception as error:
        log_error(
            logger,
            "Failed to enforce portable python",
            event="python_relaunch_failed",
            stage="bootstrap",
            detail=str(error),
        )


def _normalize_models_root(candidate: str) -> str:
    normalized = os.path.abspath(candidate)
    suffix = os.path.join("index-tts", "hub")
    if normalized.lower().endswith(suffix.lower()):
        return os.path.dirname(os.path.dirname(normalized))
    return normalized


def resolve_models_hub_dir(app_root: str, current_dir: str, argv: list[str], debug_print: Callable[[str], None]) -> str:
    if "--model_dir" in argv:
        try:
            index = argv.index("--model_dir")
            if index + 1 < len(argv):
                return _normalize_models_root(argv[index + 1])
        except Exception:
            pass

    possible_paths = [
        os.path.join(app_root, "models"),
        os.path.join(app_root, "resources", "models"),
        os.path.abspath(os.path.join(current_dir, "..", "..", "..", "models")),
        os.path.abspath(os.path.join(current_dir, "..", "models")),
    ]

    debug_print(f"[DEBUG] APP_ROOT detected as: {app_root}")
    debug_print("[DEBUG] Checking model paths:")

    for path in possible_paths:
        exists = os.path.exists(path)
        content_len = len(os.listdir(path)) if exists and os.path.isdir(path) else 0
        debug_print(f"  - {path} (Exists: {exists}, Items: {content_len})")
        if exists and content_len > 0:
            debug_print(f"  [SELECTED] Found valid model dir at: {path}")
            return _normalize_models_root(path)

    debug_print("  [WARNING] No valid model dir found in candidates. Defaulting to Root path.")
    return os.path.join(app_root, "models")


def configure_models_environment(models_hub_dir: str) -> None:
    models_root = _normalize_models_root(models_hub_dir)
    os.environ["HF_HOME"] = models_root
    os.environ["HF_HUB_CACHE"] = models_root
    os.environ["VSM_MODELS_ROOT"] = models_root
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"


def ensure_portable_ffmpeg(app_root: str, logger: logging.Logger) -> str:
    ffmpeg_bin = get_media_tool_bin_dir(app_root, "ffmpeg")
    ffmpeg_executable = os.path.join(ffmpeg_bin, "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if os.path.exists(ffmpeg_executable):
        log_business(
            logger,
            logging.INFO,
            "Using portable FFmpeg",
            event="ffmpeg_ready",
            stage="bootstrap",
            detail=ffmpeg_bin,
        )
        os.environ["PATH"] = ffmpeg_bin + os.pathsep + os.environ["PATH"]
    else:
        log_business(
            logger,
            logging.WARNING,
            "Portable FFmpeg not found, falling back to system PATH",
            event="ffmpeg_fallback",
            stage="bootstrap",
        )
    return ffmpeg_bin


def setup_gpu_paths(logger: logging.Logger) -> None:
    try:
        def add_path(path: str) -> None:
            if not os.path.exists(path):
                return
            if path not in os.environ["PATH"]:
                os.environ["PATH"] = path + os.pathsep + os.environ["PATH"]
            if hasattr(os, "add_dll_directory"):
                try:
                    os.add_dll_directory(path)
                except Exception:
                    pass

        base_dir = os.path.dirname(sys.executable)
        site_packages = os.path.join(base_dir, "Lib", "site-packages")
        if not os.path.exists(site_packages):
            site_packages = os.path.join(base_dir, "lib", "site-packages")

        if os.path.exists(site_packages):
            for package in ["cudnn", "cublas", "cuda_runtime", "cudart"]:
                for subdir in ["bin", "lib"]:
                    add_path(os.path.join(site_packages, "nvidia", package, subdir))
            add_path(os.path.join(site_packages, "torch", "lib"))

        try:
            import torch
            torch_path = os.path.dirname(torch.__file__)
            add_path(os.path.join(torch_path, "lib"))
            site_pkgs = os.path.dirname(os.path.dirname(torch.__file__))
            add_path(os.path.join(site_pkgs, "nvidia", "cudnn", "bin"))
        except Exception:
            pass
    except Exception as error:
        log_error(logger, "Failed to patch DLL paths", event="dll_patch_failed", stage="bootstrap", detail=str(error))
