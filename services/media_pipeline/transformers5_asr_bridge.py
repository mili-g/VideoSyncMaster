from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any

from bootstrap.path_layout import get_project_root, get_runtime_overlay_dir, get_storage_cache_dir, get_storage_runtime_dir, resolve_portable_python


CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = get_project_root(CURRENT_DIR)
RUNNER_PATH = os.path.join(CURRENT_DIR, "transformers5_asr_runner.py")
_CACHE_DIR = get_storage_cache_dir(PROJECT_ROOT)
_RUNTIME_DIR = get_storage_runtime_dir(PROJECT_ROOT)
PREFERRED_OVERLAY_DIR = get_runtime_overlay_dir(PROJECT_ROOT, "transformers5_asr")
LEGACY_OVERLAY_DIRS = [
    os.path.join(_RUNTIME_DIR, "transformers5_asr"),
    os.path.join(_CACHE_DIR, "transformers5_asr_overlay"),
]
_IGNORED_TRANSFORMERS5_STDERR_PATTERNS = (
    "VibeVoiceAsrProcessor` defines `feature_extractor_class",
    "Loading weights:",
)


def resolve_transformers5_overlay_dir() -> str:
    if os.path.isdir(PREFERRED_OVERLAY_DIR):
        return PREFERRED_OVERLAY_DIR
    for legacy_dir in LEGACY_OVERLAY_DIRS:
        if os.path.isdir(legacy_dir):
            return legacy_dir
    return PREFERRED_OVERLAY_DIR


def resolve_transformers5_runner_path() -> str:
    return RUNNER_PATH


def _try_parse_runner_payload(stdout: str) -> dict[str, Any] | None:
    candidate = str(stdout or "").strip()
    if not candidate:
        return None
    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _normalize_runner_stderr(stderr: str) -> str:
    lines = []
    for raw_line in str(stderr or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if any(pattern in line for pattern in _IGNORED_TRANSFORMERS5_STDERR_PATTERNS):
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def _build_runtime_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["NUMBA_DISABLE_INTEL_SVML"] = "1"
    env["NUMBA_CPU_NAME"] = "generic"

    python_root = os.path.dirname(resolve_portable_python(PROJECT_ROOT))
    site_packages = os.path.join(python_root, "Lib", "site-packages")
    torch_lib = os.path.join(site_packages, "torch", "lib")
    cuda_paths = [
        os.path.join(site_packages, "nvidia", "cudnn", "bin"),
        os.path.join(site_packages, "nvidia", "cublas", "bin"),
        os.path.join(site_packages, "nvidia", "cuda_runtime", "bin"),
        os.path.join(site_packages, "nvidia", "cuda_nvrtc", "bin"),
        torch_lib,
    ]
    existing_cuda_paths = [candidate for candidate in cuda_paths if os.path.isdir(candidate)]
    if existing_cuda_paths:
        env["PATH"] = os.pathsep.join([*existing_cuda_paths, env.get("PATH", "")])
    return env


def get_transformers5_runtime_status() -> tuple[bool, str | None]:
    overlay_dir = resolve_transformers5_overlay_dir()
    if not os.path.isdir(overlay_dir):
        return False, (
            "Transformers 5.x overlay runtime directory is missing. "
            f"Expected: {overlay_dir}"
        )

    runner_path = resolve_transformers5_runner_path()
    if not os.path.exists(runner_path):
        return False, f"Transformers 5.x runner script is missing: {runner_path}"

    python_executable = resolve_portable_python(PROJECT_ROOT)
    if not os.path.exists(python_executable):
        python_executable = sys.executable

    try:
        completed = subprocess.run(
            [python_executable, runner_path, "--mode", "status"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_build_runtime_env(),
            timeout=120,
        )
    except Exception as error:
        return False, f"Unable to start Transformers 5.x runner: {error}"

    output = "\n".join(
        part.strip() for part in [completed.stdout or "", completed.stderr or ""] if part.strip()
    ).strip()
    if completed.returncode != 0:
        return False, output or f"Transformers 5.x runner exited with code {completed.returncode}"

    try:
        payload = json.loads((completed.stdout or "").strip())
    except json.JSONDecodeError as error:
        return False, f"Transformers 5.x runner returned invalid JSON: {error}"

    if not payload.get("ok"):
        return False, str(payload.get("detail") or "Transformers 5.x runner reported unavailable")

    return True, str(payload.get("detail") or "ready")


def run_transformers5_asr_inference(
    *,
    service: str,
    audio_path: str,
    model_dir: str,
    device: str = "auto",
    max_new_tokens: int = 256,
    language: str | None = None,
) -> list[dict[str, Any]]:
    runner_path = resolve_transformers5_runner_path()
    runtime_ok, runtime_detail = get_transformers5_runtime_status()
    if not runtime_ok:
        raise RuntimeError(runtime_detail or "Transformers 5.x runtime is unavailable")

    python_executable = resolve_portable_python(PROJECT_ROOT)
    if not os.path.exists(python_executable):
        python_executable = sys.executable

    command = [
        python_executable,
        runner_path,
        "--mode",
        "infer",
        "--service",
        service,
        "--audio_path",
        audio_path,
        "--model_dir",
        model_dir,
        "--device",
        device,
        "--max_new_tokens",
        str(max(1, int(max_new_tokens or 256))),
    ]
    if language:
        command.extend(["--language", str(language)])

    completed = subprocess.run(
        command,
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_build_runtime_env(),
        timeout=1800,
    )
    stdout = (completed.stdout or "").strip()
    stderr = _normalize_runner_stderr(completed.stderr or "")
    if completed.returncode != 0:
        payload = _try_parse_runner_payload(stdout)
        payload_detail = str(payload.get("detail") or "").strip() if payload else ""
        detail = "\n".join(part for part in [payload_detail, stderr, stdout if not payload else ""] if part).strip()
        raise RuntimeError(
            detail or f"Transformers 5.x ASR runner failed with exit code {completed.returncode}"
        )

    payload = _try_parse_runner_payload(stdout)
    if payload is None:
        raise RuntimeError("Transformers 5.x ASR runner returned invalid JSON")

    if not payload.get("ok"):
        raise RuntimeError(str(payload.get("detail") or "Transformers 5.x ASR runner reported failure"))

    segments = payload.get("segments")
    if not isinstance(segments, list):
        raise RuntimeError("Transformers 5.x ASR runner returned an invalid segments payload")
    return segments
