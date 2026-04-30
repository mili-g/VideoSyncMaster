from __future__ import annotations

import contextlib
import gc
import io
import json
import os
import subprocess
import sys
from dataclasses import dataclass, asdict
from typing import Callable

from bootstrap.path_layout import get_project_root, resolve_portable_python
from funasr_asr_service import get_funasr_runtime_status
from model_profiles import get_asr_profile, resolve_existing_path
from qwen_asr_service import get_qwen_asr_runtime_status


@dataclass
class RuntimeStatus:
    ok: bool
    state: str
    detail: str


@dataclass
class AsrRuntimeCheck:
    service: str
    ok: bool
    state: str
    stage: str
    detail: str


@dataclass
class AsrRuntimeProbe:
    service: str
    ok: bool
    state: str
    detail: str
    segment_count: int = 0


def _capture_stdout(callable_obj: Callable[[], object]) -> tuple[object | None, str]:
    buffer = io.StringIO()
    try:
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            result = callable_obj()
        return result, buffer.getvalue()
    except Exception as error:
        return error, buffer.getvalue()


def _resolve_provider_model_dir(service: str, profile: str = "standard") -> str | None:
    _, profile_data = get_asr_profile(service, profile)
    return resolve_existing_path(profile_data.get("candidates") or [])


def _release_runtime_memory() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            if hasattr(torch.cuda, "ipc_collect"):
                torch.cuda.ipc_collect()
    except Exception:
        pass


def _run_probe_subprocess(service: str, probe_audio_path: str) -> dict[str, object]:
    project_root = get_project_root(os.path.dirname(os.path.abspath(__file__)))
    python_executable = resolve_portable_python(project_root)
    if not os.path.exists(python_executable):
        python_executable = sys.executable

    script_path = os.path.join(project_root, "scripts", "run_single_asr_probe.py")
    if not os.path.exists(script_path):
        raise FileNotFoundError(f"ASR probe script not found: {script_path}")

    completed = subprocess.run(
        [
            python_executable,
            script_path,
            "--service",
            service,
            "--audio_path",
            probe_audio_path,
            "--output_dir",
            os.path.dirname(probe_audio_path),
        ],
        cwd=project_root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=1800,
        env=dict(os.environ, PYTHONUTF8="1", PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8"),
    )

    stdout = (completed.stdout or "").strip()
    stderr = (completed.stderr or "").strip()
    payload = None
    if stdout:
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError:
            payload = None

    if isinstance(payload, dict):
        if stderr:
            payload["stderr"] = stderr
        return payload

    detail = "\n".join(part for part in [stdout, stderr] if part).strip()
    return {
        "ok": False,
        "service": service,
        "detail": detail or f"{service} probe subprocess returned invalid JSON",
    }


def _from_bool_runtime_status(result: tuple[bool, str | None]) -> RuntimeStatus:
    ok, detail = result
    return RuntimeStatus(
        ok=ok,
        state="ready" if ok else "blocked",
        detail=detail or ("ready" if ok else "runtime unavailable"),
    )


def get_faster_whisper_runtime_status(model_profile: str = "quality") -> RuntimeStatus:
    from asr import _resolve_faster_whisper_execution_plan, _resolve_faster_whisper_model_config

    model_config = _resolve_faster_whisper_model_config(model_profile)
    model_dir = model_config["model_dir"]
    if not model_dir:
        return RuntimeStatus(False, "blocked", (
            f"Local faster-whisper model not found for profile={model_config['profile_key']}. "
            f"Expected one of: {', '.join(model_config['candidates'])}"
        ))

    required_files = ["config.json", "model.bin", "tokenizer.json"]
    missing_files = [name for name in required_files if not os.path.exists(os.path.join(model_dir, name))]
    if missing_files:
        return RuntimeStatus(False, "blocked", f"faster-whisper model directory is incomplete: missing {', '.join(missing_files)}")

    try:
        execution_plan = _resolve_faster_whisper_execution_plan()
    except Exception as error:
        return RuntimeStatus(False, "blocked", f"runtime_unavailable:{error}")

    return RuntimeStatus(True, "ready", execution_plan["detail"])


def get_vibevoice_asr_runtime_status(model_name: str = "VibeVoice-ASR-HF") -> RuntimeStatus:
    model_dir = _resolve_provider_model_dir("vibevoice-asr", "standard")
    if not model_dir:
        return RuntimeStatus(False, "blocked", "VibeVoice-ASR model directory not found.")

    entries = os.listdir(model_dir)
    if not entries:
        return RuntimeStatus(False, "blocked", (
            "VibeVoice-ASR model directory exists but is empty. "
            "The local model download is incomplete."
        ))

    config_path = os.path.join(model_dir, "config.json")
    if not os.path.exists(config_path):
        return RuntimeStatus(False, "blocked", "VibeVoice-ASR config.json is missing from the model directory.")

    weight_candidates = [
        os.path.join(model_dir, "model.safetensors"),
        os.path.join(model_dir, "model.safetensors.index.json"),
        os.path.join(model_dir, "pytorch_model.bin"),
    ]
    if not any(os.path.exists(candidate) for candidate in weight_candidates):
        return RuntimeStatus(False, "blocked", (
            "VibeVoice-ASR model weights are missing from the model root directory. "
            "Expected model.safetensors, model.safetensors.index.json, or pytorch_model.bin."
        ))

    return RuntimeStatus(True, "ready", "ready")


def get_jianying_asr_runtime_status(probe_audio_path: str) -> RuntimeStatus:
    from jianying import JianYingASR

    if not os.path.exists(probe_audio_path):
        return RuntimeStatus(False, "blocked", f"Probe audio not found: {probe_audio_path}")

    result, captured = _capture_stdout(
        lambda: JianYingASR(probe_audio_path)._generate_sign_parameters(url="/lv/v1/upload_sign")
    )
    if isinstance(result, Exception):
        detail = str(result).strip() or captured.strip() or "Unknown JianYing sign service error"
        return RuntimeStatus(False, "blocked", detail)
    return RuntimeStatus(True, "ready", "ready")


def get_bcut_asr_runtime_status(probe_audio_path: str) -> RuntimeStatus:
    from bcut import BcutASR

    if not os.path.exists(probe_audio_path):
        return RuntimeStatus(False, "blocked", f"Probe audio not found: {probe_audio_path}")

    result, captured = _capture_stdout(lambda: BcutASR(probe_audio_path))
    if isinstance(result, Exception):
        detail = str(result).strip() or captured.strip() or "Unknown Bcut initialization error"
        return RuntimeStatus(False, "blocked", detail)
    return RuntimeStatus(True, "ready", "ready")


def collect_asr_runtime_checks(probe_audio_path: str) -> list[AsrRuntimeCheck]:
    checks: list[AsrRuntimeCheck] = []

    for service, checker, stage in [
        ("funasr", lambda: _from_bool_runtime_status(get_funasr_runtime_status()), "runtime"),
        ("qwen", lambda: _from_bool_runtime_status(get_qwen_asr_runtime_status()), "runtime"),
        ("vibevoice-asr", lambda: get_vibevoice_asr_runtime_status(), "runtime"),
        ("faster-whisper", lambda: get_faster_whisper_runtime_status(), "runtime"),
        ("bcut", lambda: get_bcut_asr_runtime_status(probe_audio_path), "runtime"),
        ("jianying", lambda: get_jianying_asr_runtime_status(probe_audio_path), "runtime"),
    ]:
        status = checker()
        checks.append(AsrRuntimeCheck(service=service, ok=status.ok, state=status.state, stage=stage, detail=status.detail or "ready"))

    return checks


def probe_asr_service(service: str, probe_audio_path: str) -> AsrRuntimeProbe:
    if not os.path.exists(probe_audio_path):
        return AsrRuntimeProbe(service=service, ok=False, state="blocked", detail=f"Probe audio not found: {probe_audio_path}")

    try:
        payload = _run_probe_subprocess(service, probe_audio_path)
    finally:
        _release_runtime_memory()

    if not payload.get("ok"):
        detail = str(payload.get("detail") or "").strip()
        captured = str(payload.get("captured") or "").strip()
        stderr = str(payload.get("stderr") or "").strip()
        detail = detail or captured or stderr or f"{service} probe failed"
        return AsrRuntimeProbe(service=service, ok=False, state="blocked", detail=detail)

    segments = payload.get("segments") if isinstance(payload.get("segments"), list) else []
    return AsrRuntimeProbe(
        service=service,
        ok=True,
        state="ready",
        detail="probe completed",
        segment_count=len(segments),
    )


def run_asr_diagnostics(probe_audio_path: str) -> dict[str, object]:
    checks = collect_asr_runtime_checks(probe_audio_path)
    probes = [
        probe_asr_service(service, probe_audio_path)
        for service in ["funasr", "vibevoice-asr", "qwen", "faster-whisper", "bcut", "jianying"]
    ]
    return {
        "probe_audio_path": probe_audio_path,
        "checks": [asdict(check) for check in checks],
        "probes": [asdict(probe) for probe in probes],
        "failed_checks": [check.service for check in checks if not check.ok],
        "failed_probes": [probe.service for probe in probes if not probe.ok],
    }
