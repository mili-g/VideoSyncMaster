from __future__ import annotations

import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from importlib import metadata
from pathlib import Path
from typing import Generator

import numpy as np
import soundfile as sf
import torch

from app_logging import get_logger, log_business, log_error, redirect_print
from audio_validation import validate_generated_audio
from bootstrap.path_layout import get_media_tool_bin_dir, get_project_root, get_runtime_root
from gpu_runtime import get_single_gpu_memory_snapshot
from infra.events import emit_partial_result, emit_progress, emit_stage
from model_profiles import normalize_tts_model_profile

logger = get_logger("tts.gpt_sovits")
print = redirect_print(logger, default_level=logging.DEBUG)

GPT_SOVITS_REPO_ZIP_URL = "https://codeload.github.com/RVC-Boss/GPT-SoVITS/zip/refs/heads/main"
GPT_SOVITS_PRETRAINED_URL = "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/pretrained_models.zip"
GPT_SOVITS_G2PW_URL = "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/G2PWModel.zip"
GPT_SOVITS_NLTK_URL = "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/nltk_data.zip"
GPT_SOVITS_OPENJTALK_URL = "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/open_jtalk_dic_utf_8-1.11.tar.gz"
BOOTSTRAP_VERSION = "videosync-gpt-sovits-v3"
PYTORCH_CUDA_INDEX_URL = "https://download.pytorch.org/whl/cu128"
BUILTIN_GPT_SOVITS_REFS = {
    "builtin://gpt-sovits/jing-yuan-cn": {
        "path": ("resources", "voice_refs", "gpt_sovits", "jing_yuan_cn.wav"),
        "prompt_text": "我是「罗浮」云骑将军景元。不必拘谨，「将军」只是一时的身份，你称呼我景元便可。",
        "prompt_lang": "zh",
        "label": "景元 男声",
    },
    "builtin://gpt-sovits/kafka-cn": {
        "path": ("resources", "voice_refs", "gpt_sovits", "kafka_cn.wav"),
        "prompt_text": "嗨，列车团…嗯，你们逮住我啦。",
        "prompt_lang": "zh",
        "label": "卡芙卡 女声",
    },
}

_SERVICE_ROOT = None
_VENV_PYTHON = None
_SERVER_PROCESS = None
_SERVER_PORT = None
_SERVER_LOG_HANDLE = None
_SERVER_WARMED = False
_SERVER_WARMUP_THREAD = None
_SERVER_WARMUP_IN_PROGRESS = False
_SERVER_IDLE_MONITOR_THREAD = None
_SERVER_STARTED_AT = 0.0
_SERVER_LAST_REAL_REQUEST_AT = 0.0
_SERVER_ACTIVE_REAL_REQUESTS = 0
_GPU_SNAPSHOT_CACHE = {"value": None, "expires_at": 0.0}
_OFFICIAL_FAST_BATCH_CAPS: dict[str, int] = {}
_ACRONYM_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9])[A-Z]{2,6}(?![A-Za-z0-9])")
_LATIN_DIGIT_RE = re.compile(r"[A-Za-z0-9]")
_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")
_SPACED_ACRONYM_RE = re.compile(r"(?<![A-Za-z0-9])(?:[A-Z](?:\s+[A-Z])+)(?![A-Za-z0-9])")
_SERVER_IDLE_TIMEOUT_SEC = 90.0
_SERVER_IDLE_MONITOR_INTERVAL_SEC = 10.0
_GPT_SOVITS_PROFILE_PRESETS = {
    "fast": {
        "gpt_sovits_official_fast_mode": True,
        "gpt_sovits_parallel_infer": True,
        "gpt_sovits_text_split_method": "cut0",
        "gpt_sovits_batch_threshold": 1.2,
        "gpt_sovits_sample_steps": 28,
        "gpt_sovits_speed_factor": 1.0,
        "temperature": 1.0,
        "top_p": 1.0,
        "repetition_penalty": 1.16,
        "gpt_sovits_use_cuda_graph": True,
    },
    "balanced": {
        "gpt_sovits_official_fast_mode": False,
        "gpt_sovits_parallel_infer": True,
        "gpt_sovits_text_split_method": "cut0",
        "gpt_sovits_batch_threshold": 0.68,
        "gpt_sovits_sample_steps": 32,
        "gpt_sovits_speed_factor": 1.0,
        "temperature": 0.92,
        "top_p": 0.96,
        "repetition_penalty": 1.20,
        "gpt_sovits_use_cuda_graph": True,
    },
    "quality": {
        "gpt_sovits_official_fast_mode": False,
        "gpt_sovits_parallel_infer": False,
        "gpt_sovits_text_split_method": "cut5",
        "gpt_sovits_batch_threshold": 0.42,
        "gpt_sovits_sample_steps": 44,
        "gpt_sovits_speed_factor": 1.0,
        "temperature": 0.78,
        "top_p": 0.90,
        "repetition_penalty": 1.26,
        "gpt_sovits_use_cuda_graph": True,
    },
}


def _project_root() -> Path:
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    return Path(get_project_root(backend_dir))


def _runtime_root() -> Path:
    return Path(get_runtime_root(str(_project_root())))


def _service_root() -> Path:
    global _SERVICE_ROOT
    if _SERVICE_ROOT is None:
        _SERVICE_ROOT = _runtime_root() / "gpt_sovits"
    return _SERVICE_ROOT


def _repo_root() -> Path:
    return _service_root() / "repo"


def _builtin_reference_root() -> Path:
    return _project_root() / "resources" / "voice_refs" / "gpt_sovits"


def _venv_root() -> Path:
    return _service_root() / "venv"


def _venv_python() -> Path:
    global _VENV_PYTHON
    if _VENV_PYTHON is None:
        _VENV_PYTHON = _venv_root() / "Scripts" / "python.exe"
    return _VENV_PYTHON


def _marker_path() -> Path:
    return _service_root() / "bootstrap-state.json"


def _generated_config_path() -> Path:
    return _service_root() / "tts_infer.generated.yaml"


def _logs_dir() -> Path:
    return _service_root() / "logs"


def _server_state_path() -> Path:
    return _service_root() / "api_v2.state.json"


def _repo_api_path() -> Path:
    return _repo_root() / "api_v2.py"


def _custom_api_server_path() -> Path:
    return Path(__file__).resolve().parent / "gpt_sovits_api_server.py"


def _repo_tts_config_template() -> Path:
    return _repo_root() / "GPT_SoVITS" / "configs" / "tts_infer.yaml"


def _required_repo_paths() -> list[Path]:
    return [
        _repo_api_path(),
        _repo_tts_config_template(),
    ]


def _required_model_paths() -> list[Path]:
    repo_root = _repo_root()
    return [
        repo_root / "GPT_SoVITS" / "pretrained_models" / "gsv-v2final-pretrained" / "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
        repo_root / "GPT_SoVITS" / "pretrained_models" / "gsv-v2final-pretrained" / "s2G2333k.pth",
        repo_root / "GPT_SoVITS" / "pretrained_models" / "chinese-roberta-wwm-ext-large",
        repo_root / "GPT_SoVITS" / "pretrained_models" / "chinese-hubert-base",
        repo_root / "GPT_SoVITS" / "text" / "G2PWModel",
    ]


def _ffmpeg_path_entries() -> list[str]:
    project_root = _project_root()
    entries = [
        get_media_tool_bin_dir(str(project_root), "ffmpeg"),
    ]
    return [entry for entry in entries if os.path.isdir(entry)]


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _python_supports_module(module_name: str) -> bool:
    probe = subprocess.run(
        [sys.executable, "-c", f"import {module_name}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )
    return probe.returncode == 0


def _ensure_virtualenv_module() -> None:
    if _python_supports_module("virtualenv"):
        return
    log_business(
        logger,
        logging.INFO,
        "Installing virtualenv into bundled Python for GPT-SoVITS bootstrap",
        event="gpt_sovits_virtualenv_install",
        stage="bootstrap",
        detail=sys.executable,
    )
    _run_checked(
        [sys.executable, "-m", "pip", "install", "--upgrade", "virtualenv"],
        cwd=_service_root(),
        timeout=1800,
    )


def _run_checked(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None, timeout: int | None = None) -> str:
    process = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )
    if process.returncode != 0:
        raise RuntimeError(
            f"Command failed ({process.returncode}): {' '.join(command)}\n"
            f"STDOUT:\n{process.stdout}\nSTDERR:\n{process.stderr}"
        )
    return process.stdout


def _download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url) as response, destination.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def _extract_zip(zip_path: Path, destination: Path) -> None:
    with zipfile.ZipFile(zip_path, "r") as archive:
        archive.extractall(destination)


def _extract_tar_gz(archive_path: Path, destination: Path) -> None:
    with tarfile.open(archive_path, "r:gz") as archive:
        archive.extractall(destination)


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        return int(sock.getsockname()[1])


def _http_json(method: str, url: str, payload: dict | None = None, *, timeout: int = 120) -> dict:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8", errors="replace")
        return json.loads(body) if body.strip() else {}


def _read_server_state() -> dict:
    state_path = _server_state_path()
    if not state_path.exists():
        return {}
    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_server_state(*, pid: int | None, port: int | None) -> None:
    state_path = _server_state_path()
    payload = {
        "pid": int(pid) if pid else None,
        "port": int(port) if port else None,
        "server_script": str(_custom_api_server_path()),
        "python": str(_venv_python()),
        "updated_at": time.time(),
    }
    try:
        state_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _clear_server_state() -> None:
    try:
        _server_state_path().unlink(missing_ok=True)
    except Exception:
        pass


def _list_windows_python_processes() -> list[tuple[int, str]]:
    command = [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        (
            "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' } | "
            "ForEach-Object { '{0}`t{1}' -f $_.ProcessId, ($_.CommandLine -replace \"`r|`n\", ' ') }"
        ),
    ]
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
        check=False,
    )
    if result.returncode != 0:
        return []
    processes: list[tuple[int, str]] = []
    for raw_line in result.stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        pid_part, _, cmdline_part = line.partition("\t")
        try:
            pid = int(pid_part.strip())
        except Exception:
            continue
        processes.append((pid, cmdline_part.strip()))
    return processes


def _process_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        if os.name == "nt":
            result = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    f"$p = Get-Process -Id {pid} -ErrorAction SilentlyContinue; if ($p) {{ '1' }}",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                check=False,
            )
            return result.returncode == 0 and bool((result.stdout or "").strip())
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _find_residual_server_pids() -> list[int]:
    current_pid = os.getpid()
    script_name = _custom_api_server_path().name
    service_marker = str(_service_root()).replace("/", "\\").lower()
    try:
        pids: list[int] = []
        if os.name == "nt":
            process_rows = _list_windows_python_processes()
        else:
            result = subprocess.run(
                ["ps", "-eo", "pid=,command="],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
                check=False,
            )
            if result.returncode != 0:
                return []
            process_rows = []
            for raw_line in result.stdout.splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                parts = line.split(maxsplit=1)
                if len(parts) != 2:
                    continue
                try:
                    process_rows.append((int(parts[0]), parts[1]))
                except Exception:
                    continue
        for pid, command_line in process_rows:
            normalized_cmd = str(command_line or "").replace("/", "\\").lower()
            if script_name.lower() not in normalized_cmd or service_marker not in normalized_cmd:
                continue
            if pid > 0 and pid != current_pid:
                pids.append(pid)
        state_pid = _read_server_state().get("pid")
        try:
            state_pid = int(state_pid)
        except Exception:
            state_pid = None
        if state_pid and state_pid != current_pid and state_pid not in pids and _process_exists(state_pid):
            pids.append(state_pid)
        return sorted(set(pids))
    except Exception:
        return []


def _kill_process_tree(pid: int) -> None:
    if pid <= 0 or pid == os.getpid():
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
                check=False,
            )
            return
        os.kill(pid, 15)
    except Exception:
        pass


def _cleanup_residual_servers() -> None:
    residual_pids = _find_residual_server_pids()
    if not residual_pids:
        return
    log_business(
        logger,
        logging.WARNING,
        "Cleaning up residual GPT-SoVITS API server processes",
        event="gpt_sovits_residual_cleanup",
        stage="bootstrap",
        detail=",".join(str(pid) for pid in residual_pids),
    )
    for pid in residual_pids:
        _kill_process_tree(pid)
    time.sleep(1.0)


def _write_generated_config() -> None:
    repo_root = _repo_root()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    is_half = "true" if device == "cuda" else "false"
    if device != "cuda":
        device = "cpu"
        is_half = "false"
    config = (
        "custom:\n"
        f"  bert_base_path: {repo_root.as_posix()}/GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large\n"
        f"  cnhuhbert_base_path: {repo_root.as_posix()}/GPT_SoVITS/pretrained_models/chinese-hubert-base\n"
        f"  device: {device}\n"
        f"  is_half: {is_half}\n"
        f"  t2s_weights_path: {repo_root.as_posix()}/GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt\n"
        "  version: v2\n"
        f"  vits_weights_path: {repo_root.as_posix()}/GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth\n"
    )
    _generated_config_path().write_text(config, encoding="utf-8")


def _ensure_repo_present() -> None:
    if all(path.exists() for path in _required_repo_paths()):
        return

    service_root = _service_root()
    repo_root = _repo_root()
    temp_zip = service_root / "gpt_sovits_repo.zip"
    temp_extract = service_root / "_repo_extract"

    log_business(logger, logging.INFO, "Downloading GPT-SoVITS official repository", event="gpt_sovits_repo_download", stage="bootstrap", detail=GPT_SOVITS_REPO_ZIP_URL)
    if repo_root.exists():
        shutil.rmtree(repo_root, ignore_errors=True)
    if temp_extract.exists():
        shutil.rmtree(temp_extract, ignore_errors=True)

    _download_file(GPT_SOVITS_REPO_ZIP_URL, temp_zip)
    _extract_zip(temp_zip, temp_extract)

    extracted_root = next((item for item in temp_extract.iterdir() if item.is_dir()), None)
    if extracted_root is None:
        raise RuntimeError("GPT-SoVITS repository archive did not contain an extractable root directory.")

    shutil.move(str(extracted_root), str(repo_root))
    temp_zip.unlink(missing_ok=True)
    shutil.rmtree(temp_extract, ignore_errors=True)


def _ensure_venv_present() -> None:
    python_path = _venv_python()
    if python_path.exists():
        return

    _ensure_dir(_service_root())
    if _python_supports_module("venv"):
        log_business(logger, logging.INFO, "Creating GPT-SoVITS isolated runtime with bundled Python venv", event="gpt_sovits_venv_builder", stage="bootstrap", detail=sys.executable)
        _run_checked(
            [
                sys.executable,
                "-m",
                "venv",
                "--system-site-packages",
                str(_venv_root()),
            ],
            cwd=_service_root(),
            timeout=1800,
        )
        return

    _ensure_virtualenv_module()
    log_business(logger, logging.INFO, "Creating GPT-SoVITS isolated runtime with bundled Python virtualenv", event="gpt_sovits_virtualenv_builder", stage="bootstrap", detail=sys.executable)
    _run_checked(
        [
            sys.executable,
            "-m",
            "virtualenv",
            "--system-site-packages",
            str(_venv_root()),
        ],
        cwd=_service_root(),
        timeout=1800,
    )


def _build_venv_env() -> dict[str, str]:
    env = os.environ.copy()
    path_entries = [str(_venv_root() / "Scripts"), *list(_ffmpeg_path_entries()), env.get("PATH", "")]
    env["PATH"] = os.pathsep.join([entry for entry in path_entries if entry])
    cpu_count = os.cpu_count() or 8
    capped_threads = str(max(2, min(6, cpu_count // 2 or 2)))
    env.setdefault("OMP_NUM_THREADS", capped_threads)
    env.setdefault("MKL_NUM_THREADS", capped_threads)
    env.setdefault("NUMEXPR_NUM_THREADS", capped_threads)
    env.setdefault("OPENBLAS_NUM_THREADS", capped_threads)
    env.setdefault("TOKENIZERS_PARALLELISM", "false")
    env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True,garbage_collection_threshold:0.8,max_split_size_mb:64")
    return env


def _prepare_requirements_for_platform(repo_root: Path) -> Path:
    requirements_path = repo_root / "requirements.txt"
    if os.name != "nt":
        return requirements_path

    filtered_requirements_path = _service_root() / "requirements.windows.filtered.txt"
    skipped_prefixes = ("pyopenjtalk", "opencc", "jieba_fast", "torchaudio", "torch", "torchvision")
    kept_lines: list[str] = []
    skipped_lines: list[str] = []
    for raw_line in requirements_path.read_text(encoding="utf-8").splitlines():
        stripped = raw_line.strip()
        if stripped and not stripped.startswith("#") and stripped.startswith(skipped_prefixes):
            skipped_lines.append(stripped)
            continue
        kept_lines.append(raw_line)

    filtered_requirements_path.write_text("\n".join(kept_lines) + "\n", encoding="utf-8")
    if skipped_lines:
        log_business(
            logger,
            logging.INFO,
            "Prepared Windows-specific GPT-SoVITS requirements",
            event="gpt_sovits_requirements_filter",
            stage="bootstrap",
            detail=", ".join(skipped_lines),
        )
    return filtered_requirements_path


def _resolve_managed_torch_versions() -> tuple[str, str, str]:
    torch_version = str(torch.__version__).strip()
    if "+" in torch_version:
        torch_version = torch_version.split("+", 1)[0]

    torchvision_version = metadata.version("torchvision")
    torchaudio_version = metadata.version("torchaudio")

    for name, value in (
        ("torch", torch_version),
        ("torchvision", torchvision_version),
        ("torchaudio", torchaudio_version),
    ):
        if "+" in value:
            value = value.split("+", 1)[0]
        if name == "torch":
            torch_version = value
        elif name == "torchvision":
            torchvision_version = value
        else:
            torchaudio_version = value

    return torch_version, torchvision_version, torchaudio_version


def _install_cuda_torch_stack(python_exe: Path, repo_root: Path, env: dict[str, str]) -> None:
    torch_version, torchvision_version, torchaudio_version = _resolve_managed_torch_versions()
    _run_checked(
        [
            str(python_exe),
            "-m",
            "pip",
            "uninstall",
            "-y",
            "torch",
            "torchvision",
            "torchaudio",
        ],
        cwd=repo_root,
        env=env,
        timeout=1800,
    )
    _run_checked(
        [
            str(python_exe),
            "-m",
            "pip",
            "install",
            "--upgrade",
            "--index-url",
            PYTORCH_CUDA_INDEX_URL,
            f"torch=={torch_version}",
            f"torchvision=={torchvision_version}",
            f"torchaudio=={torchaudio_version}",
        ],
        cwd=repo_root,
        env=env,
        timeout=3600,
    )
    _run_checked(
        [
            str(python_exe),
            "-c",
            "import torch; assert torch.cuda.is_available(), 'CUDA unavailable in GPT-SoVITS runtime'; print(torch.__version__); print(torch.version.cuda or 'none')",
        ],
        cwd=repo_root,
        env=env,
        timeout=300,
    )


def _resolve_site_packages_dir(python_exe: Path, repo_root: Path, env: dict[str, str]) -> Path:
    site_packages = _run_checked(
        [
            str(python_exe),
            "-c",
            "import site; print(site.getsitepackages()[0])",
        ],
        cwd=repo_root,
        env=env,
        timeout=120,
    ).strip()
    if not site_packages:
        raise RuntimeError("Failed to resolve site-packages directory for GPT-SoVITS runtime.")
    return Path(site_packages)


def _ensure_windows_compat_shims(repo_root: Path, python_exe: Path, env: dict[str, str]) -> None:
    if os.name != "nt":
        return
    site_packages_dir = _resolve_site_packages_dir(python_exe, repo_root, env)
    module_shim_path = site_packages_dir / "jieba_fast.py"
    if module_shim_path.exists():
        module_shim_path.unlink()

    package_dir = site_packages_dir / "jieba_fast"
    package_dir.mkdir(parents=True, exist_ok=True)
    init_path = package_dir / "__init__.py"
    posseg_path = package_dir / "posseg.py"
    init_content = "from jieba import *\nfrom jieba import posseg\n"
    posseg_content = "from jieba.posseg import *\n"
    if (
        not init_path.exists()
        or init_path.read_text(encoding="utf-8", errors="replace") != init_content
        or not posseg_path.exists()
        or posseg_path.read_text(encoding="utf-8", errors="replace") != posseg_content
    ):
        init_path.write_text(init_content, encoding="utf-8")
        posseg_path.write_text(posseg_content, encoding="utf-8")
        log_business(
            logger,
            logging.INFO,
            "Installed Windows compatibility shim for jieba_fast",
            event="gpt_sovits_windows_shim",
            stage="bootstrap",
            detail=str(package_dir),
        )

    sitecustomize_path = site_packages_dir / "sitecustomize.py"
    sitecustomize_content = """import os
try:
    import numpy as _np
    import soundfile as _sf
    import torch as _torch
    import torchaudio as _torchaudio
except Exception:
    _np = _sf = _torch = _torchaudio = None

if _torchaudio is not None and _sf is not None and _torch is not None:
    _original_load = _torchaudio.load

    def _decode_audio_fallback(filepath):
        audio, sample_rate = _sf.read(filepath, dtype='float32', always_2d=True)
        audio = _np.ascontiguousarray(audio.T)
        return _torch.from_numpy(audio), sample_rate

    def _load_with_windows_fallback(filepath, *args, **kwargs):
        try:
            return _original_load(filepath, *args, **kwargs)
        except Exception as exc:
            message = str(exc).lower()
            if 'torchcodec' not in message and 'libtorchcodec' not in message:
                raise
            return _decode_audio_fallback(filepath)

    _torchaudio.load = _load_with_windows_fallback
"""
    if not sitecustomize_path.exists() or sitecustomize_path.read_text(encoding="utf-8", errors="replace") != sitecustomize_content:
        sitecustomize_path.write_text(sitecustomize_content, encoding="utf-8")
        log_business(
            logger,
            logging.INFO,
            "Installed Windows torchaudio fallback shim for GPT-SoVITS",
            event="gpt_sovits_torchaudio_shim",
            stage="bootstrap",
            detail=str(sitecustomize_path),
        )


def _ensure_python_dependencies() -> None:
    marker_path = _marker_path()
    if marker_path.exists():
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            if marker.get("version") == BOOTSTRAP_VERSION:
                return
        except Exception:
            pass

    repo_root = _repo_root()
    python_exe = _venv_python()
    env = _build_venv_env()
    requirements_path = _prepare_requirements_for_platform(repo_root)

    _run_checked([str(python_exe), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"], cwd=repo_root, env=env, timeout=1800)
    _run_checked([str(python_exe), "-m", "pip", "install", "--prefer-binary", "-r", "extra-req.txt", "--no-deps"], cwd=repo_root, env=env, timeout=1800)
    if os.name == "nt":
        _install_cuda_torch_stack(python_exe, repo_root, env)
    _run_checked([str(python_exe), "-m", "pip", "install", "--prefer-binary", "-r", str(requirements_path)], cwd=repo_root, env=env, timeout=7200)
    if os.name == "nt":
        _run_checked(
            [
                str(python_exe),
                "-m",
                "pip",
                "install",
                "--prefer-binary",
                "--upgrade",
                "pyopenjtalk-prebuilt",
                "opencc-python-reimplemented",
                "torchcodec",
            ],
            cwd=repo_root,
            env=env,
            timeout=3600,
        )
        _install_cuda_torch_stack(python_exe, repo_root, env)
    else:
        _run_checked([str(python_exe), "-m", "pip", "install", "--upgrade", "torchcodec"], cwd=repo_root, env=env, timeout=1800)

    _ensure_windows_compat_shims(repo_root, python_exe, env)
    marker_path.write_text(json.dumps({"version": BOOTSTRAP_VERSION, "installedAt": time.time()}, ensure_ascii=False, indent=2), encoding="utf-8")


def _ensure_pretrained_assets() -> None:
    repo_root = _repo_root()
    pretrained_root = repo_root / "GPT_SoVITS" / "pretrained_models"
    text_root = repo_root / "GPT_SoVITS" / "text"
    _ensure_dir(pretrained_root)
    _ensure_dir(text_root)

    if not (pretrained_root / "sv").exists():
        archive_path = _service_root() / "pretrained_models.zip"
        _download_file(GPT_SOVITS_PRETRAINED_URL, archive_path)
        _extract_zip(archive_path, repo_root / "GPT_SoVITS")
        archive_path.unlink(missing_ok=True)

    if not (text_root / "G2PWModel").exists():
        archive_path = _service_root() / "G2PWModel.zip"
        _download_file(GPT_SOVITS_G2PW_URL, archive_path)
        _extract_zip(archive_path, text_root)
        archive_path.unlink(missing_ok=True)

    nltk_marker = _venv_root() / "nltk_data"
    if not nltk_marker.exists():
        archive_path = _service_root() / "nltk_data.zip"
        _download_file(GPT_SOVITS_NLTK_URL, archive_path)
        _extract_zip(archive_path, _venv_root())
        archive_path.unlink(missing_ok=True)

    openjtalk_marker = _service_root() / ".openjtalk-ready"
    if not openjtalk_marker.exists():
        archive_path = _service_root() / "open_jtalk_dic_utf_8-1.11.tar.gz"
        _download_file(GPT_SOVITS_OPENJTALK_URL, archive_path)
        env = _build_venv_env()
        python_exe = _venv_python()
        target = _run_checked(
            [
                str(python_exe),
                "-c",
                "import os, pyopenjtalk; print(os.path.dirname(pyopenjtalk.__file__))",
            ],
            cwd=repo_root,
            env=env,
            timeout=120,
        ).strip()
        if not target:
            raise RuntimeError("Failed to resolve pyopenjtalk installation path for GPT-SoVITS.")
        _extract_tar_gz(archive_path, Path(target))
        archive_path.unlink(missing_ok=True)
        openjtalk_marker.write_text("ok", encoding="utf-8")


def _map_language(value: str, *, allow_auto: bool = False) -> str:
    normalized = str(value or "").strip().lower()
    mapping = {
        "zh": "zh",
        "chinese": "zh",
        "中文": "zh",
        "en": "en",
        "english": "en",
        "ja": "ja",
        "japanese": "ja",
        "日本語": "ja",
        "ko": "ko",
        "korean": "ko",
        "한국어": "ko",
        "yue": "yue",
        "cantonese": "yue",
    }
    if allow_auto and normalized in {"auto", ""}:
        return "en"
    if normalized in mapping:
        return mapping[normalized]
    raise RuntimeError(f"GPT-SoVITS 当前仅支持 Chinese/English/Japanese/Korean/Cantonese，收到语言: {value}")


def _ensure_runtime_ready() -> None:
    _ensure_dir(_service_root())
    _ensure_repo_present()
    _ensure_venv_present()
    _ensure_python_dependencies()
    _ensure_windows_compat_shims(_repo_root(), _venv_python(), _build_venv_env())
    _ensure_pretrained_assets()
    _write_generated_config()


def bootstrap_gpt_sovits_runtime() -> tuple[bool, str | None]:
    _ensure_runtime_ready()
    _start_server()
    return get_gpt_sovits_runtime_status()


def _server_ready() -> bool:
    global _SERVER_PROCESS, _SERVER_PORT
    if _SERVER_PROCESS is None or _SERVER_PORT is None:
        return False
    if _SERVER_PROCESS.poll() is not None:
        return False
    try:
        request = urllib.request.Request(f"http://127.0.0.1:{_SERVER_PORT}/control", method="GET")
        with urllib.request.urlopen(request, timeout=2):
            return True
    except urllib.error.HTTPError as error:
        return error.code in {200, 400}
    except Exception:
        return False


def _stop_server() -> None:
    global _SERVER_PROCESS, _SERVER_PORT, _SERVER_LOG_HANDLE, _SERVER_WARMED, _SERVER_WARMUP_THREAD, _SERVER_WARMUP_IN_PROGRESS, _SERVER_IDLE_MONITOR_THREAD, _SERVER_STARTED_AT, _SERVER_LAST_REAL_REQUEST_AT, _SERVER_ACTIVE_REAL_REQUESTS
    if _SERVER_PROCESS is not None and _SERVER_PROCESS.poll() is None:
        try:
            _SERVER_PROCESS.terminate()
            _SERVER_PROCESS.wait(timeout=15)
        except Exception:
            try:
                _SERVER_PROCESS.kill()
            except Exception:
                pass
    _SERVER_PROCESS = None
    _SERVER_PORT = None
    if _SERVER_LOG_HANDLE is not None:
        try:
            _SERVER_LOG_HANDLE.close()
        except Exception:
            pass
    _SERVER_LOG_HANDLE = None
    _SERVER_WARMED = False
    _SERVER_WARMUP_THREAD = None
    _SERVER_WARMUP_IN_PROGRESS = False
    _SERVER_IDLE_MONITOR_THREAD = None
    _SERVER_STARTED_AT = 0.0
    _SERVER_LAST_REAL_REQUEST_AT = 0.0
    _SERVER_ACTIVE_REAL_REQUESTS = 0
    _clear_server_state()


def _warmup_artifacts_dir() -> Path:
    return _service_root() / "warmup"


def _build_warmup_payload() -> tuple[dict, list[Path]]:
    ref_audio_path, prompt_text, prompt_lang = resolve_builtin_reference(
        "builtin://gpt-sovits/jing-yuan-cn",
        "",
        "",
    )
    output_dir = _warmup_artifacts_dir()
    _ensure_dir(output_dir)
    warmup_texts = [
        "Warm up the GPT SoVITS runtime.",
        "Keep the shared reference path ready.",
        "Prime the text to semantic decoder.",
        "Prime the vocoder batch path.",
        "Reduce the first request latency.",
        "Hold the GPU fast path in memory.",
    ]
    output_paths = [output_dir / f"warmup_{index}.wav" for index in range(len(warmup_texts))]
    payload = _build_request_payload(
        warmup_texts[0],
        str(ref_audio_path),
        "English",
        {
            "gpt_sovits_prompt_text": prompt_text,
            "gpt_sovits_prompt_lang": prompt_lang,
            "voice_mode": "narration",
            "batch_size": 6,
            "gpt_sovits_parallel_infer": True,
            "gpt_sovits_text_split_method": "cut0",
            "gpt_sovits_batch_threshold": 1.2,
            "gpt_sovits_sample_steps": 28,
            "gpt_sovits_official_fast_mode": True,
            "gpt_sovits_use_cuda_graph": False,
        },
    )
    payload["items"] = [
        {
            "index": index,
            "text": text,
            "output_path": str(output_paths[index]),
        }
        for index, text in enumerate(warmup_texts)
    ]
    payload["text"] = warmup_texts[0]
    payload["warmup_mode"] = True
    return payload, output_paths


def _warmup_server() -> None:
    global _SERVER_WARMED, _SERVER_WARMUP_IN_PROGRESS
    if (
        _SERVER_WARMED
        or _SERVER_PORT is None
        or _SERVER_WARMUP_IN_PROGRESS
        or _SERVER_ACTIVE_REAL_REQUESTS > 0
        or (_SERVER_LAST_REAL_REQUEST_AT >= _SERVER_STARTED_AT > 0.0)
    ):
        return
    _SERVER_WARMUP_IN_PROGRESS = True
    payload, output_paths = _build_warmup_payload()
    request = urllib.request.Request(
        f"http://127.0.0.1:{_SERVER_PORT}/tts_batch",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=1800) as response:
            body = response.read().decode("utf-8", errors="replace")
        decoded = json.loads(body) if body.strip() else {}
        results = decoded.get("results")
        if not isinstance(results, list):
            raise RuntimeError("GPT-SoVITS warmup did not return results")
        _SERVER_WARMED = True
        log_business(
            logger,
            logging.INFO,
            "Warmup completed for GPT-SoVITS API server",
            event="gpt_sovits_warmup_complete",
            stage="bootstrap",
            detail=f"items={len(results)}",
        )
    except Exception as error:
        log_business(
            logger,
            logging.WARNING,
            "GPT-SoVITS API server warmup failed",
            event="gpt_sovits_warmup_failed",
            stage="bootstrap",
            detail=str(error),
        )
    finally:
        _SERVER_WARMUP_IN_PROGRESS = False
        for output_path in output_paths:
            try:
                output_path.unlink(missing_ok=True)
            except Exception:
                pass


def _launch_background_warmup() -> None:
    global _SERVER_WARMUP_THREAD
    if _SERVER_WARMED or _SERVER_PORT is None:
        return
    if _SERVER_WARMUP_THREAD is not None and _SERVER_WARMUP_THREAD.is_alive():
        return

    def _background_worker() -> None:
        time.sleep(10.0)
        _warmup_server()

    warmup_thread = threading.Thread(
        target=_background_worker,
        name="gpt-sovits-warmup",
        daemon=True,
    )
    _SERVER_WARMUP_THREAD = warmup_thread
    warmup_thread.start()


def _launch_idle_monitor() -> None:
    global _SERVER_IDLE_MONITOR_THREAD
    existing = _SERVER_IDLE_MONITOR_THREAD
    if existing is not None and existing.is_alive():
        return

    def _monitor() -> None:
        while True:
            time.sleep(_SERVER_IDLE_MONITOR_INTERVAL_SEC)
            if _SERVER_PROCESS is None or _SERVER_PORT is None:
                return
            if _SERVER_ACTIVE_REAL_REQUESTS > 0:
                continue
            last_real_request_at = float(_SERVER_LAST_REAL_REQUEST_AT or 0.0)
            if last_real_request_at <= 0.0:
                continue
            idle_for = time.time() - last_real_request_at
            if idle_for < _SERVER_IDLE_TIMEOUT_SEC:
                continue
            log_business(
                logger,
                logging.INFO,
                "Stopping idle GPT-SoVITS API server to release GPU memory",
                event="gpt_sovits_idle_shutdown",
                stage="bootstrap",
                detail=f"idle_for={idle_for:.1f}s timeout={_SERVER_IDLE_TIMEOUT_SEC:.1f}s",
            )
            _stop_server()
            return

    idle_thread = threading.Thread(
        target=_monitor,
        name="gpt-sovits-idle-monitor",
        daemon=True,
    )
    _SERVER_IDLE_MONITOR_THREAD = idle_thread
    idle_thread.start()


def _start_server() -> None:
    global _SERVER_PROCESS, _SERVER_PORT, _SERVER_LOG_HANDLE, _SERVER_STARTED_AT, _SERVER_LAST_REAL_REQUEST_AT
    if _server_ready():
        return

    _ensure_runtime_ready()
    _stop_server()
    _cleanup_residual_servers()
    _ensure_dir(_logs_dir())
    _SERVER_PORT = _find_free_port()
    log_path = _logs_dir() / "api_v2.log"
    env = _build_venv_env()
    repo_root = _repo_root()
    python_exe = _venv_python()
    command = [
        str(python_exe),
        str(_custom_api_server_path()),
        "-r",
        str(repo_root),
        "-a",
        "127.0.0.1",
        "-p",
        str(_SERVER_PORT),
        "-c",
        str(_generated_config_path()),
    ]
    _SERVER_LOG_HANDLE = log_path.open("a", encoding="utf-8")
    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    _SERVER_PROCESS = subprocess.Popen(
        command,
        cwd=str(repo_root),
        env=env,
        stdout=_SERVER_LOG_HANDLE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=creationflags,
    )
    _SERVER_STARTED_AT = time.time()
    _SERVER_LAST_REAL_REQUEST_AT = 0.0
    _write_server_state(pid=_SERVER_PROCESS.pid, port=_SERVER_PORT)
    deadline = time.time() + 240
    while time.time() < deadline:
        if _server_ready():
            _launch_background_warmup()
            _launch_idle_monitor()
            return
        if _SERVER_PROCESS.poll() is not None:
            break
        time.sleep(2)
    _stop_server()
    raise RuntimeError(f"GPT-SoVITS API 服务启动失败。请查看日志：{log_path}")


def get_gpt_sovits_runtime_status():
    missing = []
    if not _repo_api_path().exists():
        missing.append("官方 repo")
    if not _venv_python().exists():
        missing.append("独立 Python 运行时")
    if not _marker_path().exists():
        missing.append("bootstrap-state.json")
    if not _generated_config_path().exists():
        missing.append("tts_infer.generated.yaml")
    for required in _required_model_paths():
        if not required.exists():
            missing.append(required.name)
            break
    if missing:
        return False, "GPT-SoVITS 尚未完成初始化，缺少: " + " / ".join(missing)
    return True, None


def cleanup_gpt_sovits_runtime():
    _stop_server()
    _clear_learned_official_fast_batch_caps()


def _begin_real_request() -> None:
    global _SERVER_ACTIVE_REAL_REQUESTS, _SERVER_LAST_REAL_REQUEST_AT
    _SERVER_ACTIVE_REAL_REQUESTS += 1
    _SERVER_LAST_REAL_REQUEST_AT = time.time()


def _end_real_request(*, success: bool) -> None:
    global _SERVER_ACTIVE_REAL_REQUESTS, _SERVER_WARMED, _SERVER_LAST_REAL_REQUEST_AT
    _SERVER_ACTIVE_REAL_REQUESTS = max(0, int(_SERVER_ACTIVE_REAL_REQUESTS) - 1)
    _SERVER_LAST_REAL_REQUEST_AT = time.time()
    if success:
        _SERVER_WARMED = True


def _resolve_gpt_sovits_profile_id(kwargs: dict | None) -> str:
    payload = dict(kwargs or {})
    requested_profile = payload.get("tts_model_profile")
    if requested_profile not in (None, ""):
        return normalize_tts_model_profile("gptsovits", requested_profile)
    if bool(payload.get("gpt_sovits_official_fast_mode", False)):
        return "fast"
    return normalize_tts_model_profile("gptsovits", requested_profile)


def _get_gpt_sovits_profile_preset(profile_id: str) -> dict:
    return dict(_GPT_SOVITS_PROFILE_PRESETS.get(str(profile_id or "").strip().lower(), _GPT_SOVITS_PROFILE_PRESETS["balanced"]))


def apply_gpt_sovits_profile_defaults(kwargs: dict | None, *, preserve_existing: bool = True) -> dict:
    adjusted = dict(kwargs or {})
    preset = _get_gpt_sovits_profile_preset(_resolve_gpt_sovits_profile_id(adjusted))
    for key, value in preset.items():
        if preserve_existing and key in adjusted and adjusted.get(key) not in (None, ""):
            continue
        adjusted[key] = value
    adjusted["tts_model_profile"] = _resolve_gpt_sovits_profile_id(adjusted)
    return adjusted


def get_gpt_sovits_runtime_diagnostics(*, text: str = "", batch_size: int = 1, **kwargs) -> dict:
    profiled_kwargs = apply_gpt_sovits_profile_defaults(kwargs)
    snapshot = _get_cached_gpu_snapshot(max_age_sec=0.5)
    text_units = _estimate_text_unit_count(text)
    single_profile = _compute_gpt_sovits_dynamic_limits(snapshot, text_units=text_units, bucket_name="short")
    batch_profile = _compute_gpt_sovits_dynamic_limits(snapshot, text_units=text_units, bucket_name="medium" if text_units <= 28 else "long")
    official_fast_mode = bool(profiled_kwargs.get("gpt_sovits_official_fast_mode", False))
    effective_single = _apply_dynamic_single_profile(
        {
            "batch_size": batch_size,
            "gpt_sovits_parallel_infer": bool(profiled_kwargs.get("gpt_sovits_parallel_infer", True)),
            "gpt_sovits_sample_steps": int(profiled_kwargs.get("gpt_sovits_sample_steps", 28 if official_fast_mode else 32) or (28 if official_fast_mode else 32)),
            "gpt_sovits_batch_threshold": float(profiled_kwargs.get("gpt_sovits_batch_threshold", 1.2 if official_fast_mode else 0.68) or (1.2 if official_fast_mode else 0.68)),
            "gpt_sovits_text_split_method": str(profiled_kwargs.get("gpt_sovits_text_split_method") or ("cut0" if official_fast_mode else "cut5")),
        },
        text=text,
    )
    effective_batch, _ = _apply_dynamic_batch_profile(
        {
            "batch_size": batch_size,
            "gpt_sovits_parallel_infer": bool(profiled_kwargs.get("gpt_sovits_parallel_infer", True)),
            "gpt_sovits_sample_steps": int(profiled_kwargs.get("gpt_sovits_sample_steps", 28 if official_fast_mode else 32) or (28 if official_fast_mode else 32)),
            "gpt_sovits_batch_threshold": float(profiled_kwargs.get("gpt_sovits_batch_threshold", 1.2 if official_fast_mode else 0.68) or (1.2 if official_fast_mode else 0.68)),
            "gpt_sovits_text_split_method": str(profiled_kwargs.get("gpt_sovits_text_split_method") or ("cut0" if official_fast_mode else "cut5")),
        },
        bucket_name="medium" if text_units <= 28 else "long",
        text_units=text_units,
    )
    return {
        "service": "gptsovits",
        "runtime_ok": get_gpt_sovits_runtime_status()[0],
        "snapshot": snapshot,
        "tier": single_profile.get("tier"),
        "model_profile": _resolve_gpt_sovits_profile_id(profiled_kwargs),
        "text_units": text_units,
        "official_fast_mode": official_fast_mode,
        "effective_single": {
            "batch_size": int(effective_single.get("batch_size", 1)),
            "parallel_infer": bool(effective_single.get("gpt_sovits_parallel_infer", False)),
            "sample_steps": int(effective_single.get("gpt_sovits_sample_steps", 28)),
            "batch_threshold": float(effective_single.get("gpt_sovits_batch_threshold", 0.68)),
            "text_split_method": str(effective_single.get("gpt_sovits_text_split_method") or "cut5"),
        },
        "effective_batch": {
            "batch_size": int(effective_batch.get("batch_size", 1)),
            "parallel_infer": bool(effective_batch.get("gpt_sovits_parallel_infer", False)),
            "sample_steps": int(effective_batch.get("gpt_sovits_sample_steps", 28)),
            "batch_threshold": float(effective_batch.get("gpt_sovits_batch_threshold", 0.68)),
            "text_split_method": str(effective_batch.get("gpt_sovits_text_split_method") or "cut5"),
        },
        "profiles": {
            "single": single_profile,
            "batch": batch_profile,
        },
    }


def _build_request_payload(text: str, ref_audio_path: str, language: str, kwargs: dict) -> dict:
    kwargs = apply_gpt_sovits_profile_defaults(kwargs)
    prompt_text = str(kwargs.get("gpt_sovits_prompt_text") or kwargs.get("prompt_text") or "").strip()
    if not prompt_text:
        raise RuntimeError("GPT-SoVITS 缺少参考音频对应的提示文本。")
    official_fast_mode = bool(kwargs.get("gpt_sovits_official_fast_mode", False))
    target_lang = _map_language(language, allow_auto=False)
    prompt_lang = _map_language(str(kwargs.get("gpt_sovits_prompt_lang") or kwargs.get("prompt_lang") or language), allow_auto=True)
    effective_batch_size = min(12 if official_fast_mode else 8, max(1, int(kwargs.get("batch_size", 1) or 1)))
    explicit_cuda_graph = kwargs.get("gpt_sovits_use_cuda_graph")
    return {
        "text": text,
        "text_lang": target_lang,
        "ref_audio_path": ref_audio_path,
        "prompt_text": prompt_text,
        "prompt_lang": prompt_lang,
        "top_k": int(kwargs.get("top_k", 15) or 15),
        "top_p": float(kwargs.get("top_p", 1.0) or 1.0),
        "temperature": float(kwargs.get("temperature", 1.0) or 1.0),
        "text_split_method": str(kwargs.get("gpt_sovits_text_split_method") or ("cut0" if official_fast_mode else "cut5")),
        "batch_size": effective_batch_size,
        "batch_threshold": float(kwargs.get("gpt_sovits_batch_threshold", 1.2 if official_fast_mode else 0.68) or (1.2 if official_fast_mode else 0.68)),
        "split_bucket": bool(kwargs.get("gpt_sovits_split_bucket", kwargs.get("split_bucket", True))),
        "speed_factor": float(kwargs.get("gpt_sovits_speed_factor", 1.0) or 1.0),
        "fragment_interval": 0.0001 if official_fast_mode else 0.3,
        "seed": -1,
        "media_type": "wav",
        "streaming_mode": False,
        "parallel_infer": bool(kwargs.get("gpt_sovits_parallel_infer", False)),
        "repetition_penalty": float(kwargs.get("repetition_penalty", 1.35) or 1.35),
        "sample_steps": int(kwargs.get("gpt_sovits_sample_steps", 28) or 28),
        "super_sampling": False,
        "official_fast_mode": official_fast_mode,
        "use_cuda_graph": bool(
            (
                explicit_cuda_graph
                if explicit_cuda_graph is not None
                else (official_fast_mode and effective_batch_size <= 1)
            ) if effective_batch_size <= 1 else False
        ),
    }


def _summarize_request_payload(payload: dict) -> str:
    return (
        f"ref={Path(str(payload.get('ref_audio_path') or '')).name} "
        f"text_len={len(str(payload.get('text') or ''))} "
        f"prompt_len={len(str(payload.get('prompt_text') or ''))} "
        f"batch_size={payload.get('batch_size')} "
        f"batch_threshold={payload.get('batch_threshold')} "
        f"split_bucket={payload.get('split_bucket')} "
        f"parallel_infer={payload.get('parallel_infer')} "
        f"sample_steps={payload.get('sample_steps')} "
        f"speed_factor={payload.get('speed_factor')} "
        f"text_split={payload.get('text_split_method')}"
    )


def _validate_output(audio_path: str) -> float:
    ok, info = validate_generated_audio(audio_path)
    if not ok:
        recovered_duration = _recover_low_level_output(audio_path)
        if recovered_duration is not None:
            return recovered_duration
        raise RuntimeError(f"GPT-SoVITS 生成音频未通过校验: {info}")
    try:
        return float(sf.info(audio_path).duration)
    except Exception as error:
        raise RuntimeError(f"无法读取 GPT-SoVITS 输出音频时长: {error}") from error


def _estimate_text_unit_count(text: str) -> int:
    content = re.sub(r"\s+", "", str(text or ""))
    content = re.sub(r"[^\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]", "", content)
    return len(content)


def _normalize_gpt_sovits_text(text: str, *, language: str = "English") -> str:
    normalized = str(text or "").strip()
    if not normalized:
        return normalized

    normalized = re.sub(r"\s+", " ", normalized)
    normalized = re.sub(r"(?<=[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])(?=[A-Za-z0-9])", " ", normalized)
    normalized = re.sub(r"(?<=[A-Za-z0-9])(?=[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])", " ", normalized)

    def expand_acronym(match: re.Match[str]) -> str:
        token = match.group(0)
        return " ".join(token) if len(token) > 1 else token

    normalized = _ACRONYM_TOKEN_RE.sub(expand_acronym, normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()

    lang = _map_language(language, allow_auto=True)
    if lang in {"zh", "yue"} and not re.search(r"[。！？.!?]$", normalized):
        if _LATIN_DIGIT_RE.search(normalized) and _CJK_RE.search(normalized):
            normalized = f"{normalized}。"
    return normalized


def _is_mixed_script_text(text: str) -> bool:
    value = str(text or "")
    return bool(_LATIN_DIGIT_RE.search(value) and _CJK_RE.search(value))


def _count_acronym_letters(text: str) -> int:
    content = str(text or "")
    total = sum(len(match.group(0)) for match in _ACRONYM_TOKEN_RE.finditer(content))
    for token in _SPACED_ACRONYM_RE.findall(content):
        total += len(re.findall(r"[A-Z]", token))
    return total


def _normalize_verification_text(text: str) -> str:
    content = str(text or "").upper()
    if not content:
        return ""

    def collapse_spaced_acronym(match: re.Match[str]) -> str:
        return "".join(re.findall(r"[A-Z]", match.group(0)))

    content = _SPACED_ACRONYM_RE.sub(collapse_spaced_acronym, content)
    content = re.sub(r"\s+", "", content)
    content = re.sub(r"[^\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]", "", content)
    return content


def _measure_text_coverage(expected_text: str, actual_text: str) -> float:
    expected = _normalize_verification_text(expected_text)
    actual = _normalize_verification_text(actual_text)
    if not expected:
        return 1.0
    if not actual:
        return 0.0

    if actual in expected:
        return min(1.0, len(actual) / max(len(expected), 1))

    from difflib import SequenceMatcher

    matcher = SequenceMatcher(None, expected, actual)
    matched = sum(block.size for block in matcher.get_matching_blocks())
    return min(1.0, matched / max(len(expected), 1))


def _strip_latin_digits_for_verification(text: str) -> str:
    content = _normalize_verification_text(text)
    if not content:
        return ""
    return re.sub(r"[A-Z0-9_]+", "", content)


def _measure_cjk_skeleton_coverage(expected_text: str, actual_text: str) -> float:
    expected = _strip_latin_digits_for_verification(expected_text)
    actual = _strip_latin_digits_for_verification(actual_text)
    if not expected:
        return 1.0
    if not actual:
        return 0.0

    if expected in actual or actual in expected:
        shorter = min(len(expected), len(actual))
        longer = max(len(expected), len(actual), 1)
        return min(1.0, shorter / longer)

    from difflib import SequenceMatcher

    matcher = SequenceMatcher(None, expected, actual)
    matched = sum(block.size for block in matcher.get_matching_blocks())
    return min(1.0, matched / max(len(expected), 1))


def _should_verify_text_fidelity(text: str) -> bool:
    return False


def _transcribe_audio_for_text_verification(audio_path: str, *, language: str) -> str:
    from asr import _run_faster_whisper_local

    segments = _run_faster_whisper_local(
        audio_path,
        language=language,
        splitter_kwargs=None,
        apply_splitter=False,
        output_dir=None,
        model_profile="fast",
        optimize_output=False,
        faster_whisper_vad_filter=True,
        faster_whisper_vad_threshold=0.35,
        device="auto",
    )
    if not isinstance(segments, list):
        return ""
    return " ".join(str(segment.get("text") or "") for segment in segments).strip()


def _verify_gpt_sovits_text_fidelity(audio_path: str, expected_text: str, *, language: str) -> float:
    if not _should_verify_text_fidelity(expected_text):
        return 1.0

    asr_language = _map_language(language, allow_auto=True)
    transcript = _transcribe_audio_for_text_verification(audio_path, language=asr_language)
    coverage = _measure_text_coverage(expected_text, transcript)
    cjk_skeleton_coverage = _measure_cjk_skeleton_coverage(expected_text, transcript)
    threshold = 0.82 if (_is_mixed_script_text(expected_text) or _count_acronym_letters(expected_text) > 0) else 0.72
    if (
        coverage < threshold
        and _is_mixed_script_text(expected_text)
        and cjk_skeleton_coverage >= 0.92
        and coverage >= 0.62
    ):
        return max(coverage, min(0.90, cjk_skeleton_coverage))
    if coverage < threshold:
        raise RuntimeError(
            f"GPT-SoVITS 文本覆盖不足 (coverage={coverage:.2f} cjk_coverage={cjk_skeleton_coverage:.2f} threshold={threshold:.2f} expected={expected_text} actual={transcript})"
        )
    return coverage


def _is_text_fidelity_error_message(message: str) -> bool:
    return "文本覆盖不足" in str(message or "")


def _get_cached_gpu_snapshot(max_age_sec: float = 2.0) -> dict | None:
    now = time.time()
    cached = _GPU_SNAPSHOT_CACHE.get("value")
    expires_at = float(_GPU_SNAPSHOT_CACHE.get("expires_at") or 0.0)
    if cached is not None and now < expires_at:
        return cached

    snapshot = get_single_gpu_memory_snapshot()
    _GPU_SNAPSHOT_CACHE["value"] = snapshot
    _GPU_SNAPSHOT_CACHE["expires_at"] = now + max(0.5, float(max_age_sec or 2.0))
    return snapshot


def _official_fast_batch_cap_key(*, gpu_tier: str, voice_mode: str) -> str:
    return f"{str(gpu_tier or 'unknown').strip().lower()}::{str(voice_mode or 'default').strip().lower()}"


def _get_learned_official_fast_batch_cap(*, gpu_tier: str, voice_mode: str) -> int | None:
    value = _OFFICIAL_FAST_BATCH_CAPS.get(_official_fast_batch_cap_key(gpu_tier=gpu_tier, voice_mode=voice_mode))
    return int(value) if value and int(value) > 0 else None


def _remember_official_fast_batch_cap(*, gpu_tier: str, voice_mode: str, batch_size: int) -> None:
    safe_batch = max(1, int(batch_size or 1))
    key = _official_fast_batch_cap_key(gpu_tier=gpu_tier, voice_mode=voice_mode)
    previous = _OFFICIAL_FAST_BATCH_CAPS.get(key)
    if previous is None:
        _OFFICIAL_FAST_BATCH_CAPS[key] = safe_batch
    else:
        _OFFICIAL_FAST_BATCH_CAPS[key] = min(int(previous), safe_batch)


def _clear_learned_official_fast_batch_caps() -> None:
    _OFFICIAL_FAST_BATCH_CAPS.clear()


def _classify_gpt_sovits_gpu_tier(snapshot: dict | None) -> str:
    if not snapshot:
        return "unknown"

    free_gb = float(snapshot.get("free_gb") or 0.0)
    total_gb = float(snapshot.get("total_gb") or 0.0)
    free_ratio = (free_gb / total_gb) if total_gb > 0 else 0.0

    if free_gb < 2.5 or free_ratio < 0.12:
        return "critical"
    if total_gb < 10.0 or free_gb < 4.0 or free_ratio < 0.22:
        return "tight"
    if total_gb < 16.0 or free_gb < 7.0 or free_ratio < 0.35:
        return "balanced"
    return "roomy"


def _compute_gpt_sovits_dynamic_limits(snapshot: dict | None, *, text_units: int = 0, bucket_name: str = "") -> dict:
    tier = _classify_gpt_sovits_gpu_tier(snapshot)
    bucket = str(bucket_name or "").strip().lower()
    text_units = max(int(text_units or 0), 0)

    if tier == "critical":
        limits = {
            "max_batch_size": 1,
            "allow_parallel_infer": False,
            "min_sample_steps": 44,
            "max_batch_threshold": 0.26,
            "force_split_bucket": False,
            "text_split_method": "cut0",
        }
    elif tier in {"tight", "unknown"}:
        limits = {
            "max_batch_size": 1 if bucket == "short" else 2,
            "allow_parallel_infer": False,
            "min_sample_steps": 40,
            "max_batch_threshold": 0.32 if bucket == "short" else 0.42,
            "force_split_bucket": bucket == "long",
            "text_split_method": "cut0" if (bucket == "short" or text_units <= 36) else "cut5",
        }
    elif tier == "balanced":
        limits = {
            "max_batch_size": 2 if bucket == "short" else (3 if bucket == "medium" else 4),
            "allow_parallel_infer": bucket in {"medium", "long"},
            "min_sample_steps": 32,
            "max_batch_threshold": 0.42 if bucket == "short" else (0.58 if bucket == "medium" else 0.70),
            "force_split_bucket": bucket == "long",
            "text_split_method": "cut0" if (bucket == "short" or text_units <= 24) else "cut5",
        }
    else:
        limits = {
            "max_batch_size": 3 if bucket == "short" else (4 if bucket == "medium" else 6),
            "allow_parallel_infer": bucket != "short",
            "min_sample_steps": 28,
            "max_batch_threshold": 0.48 if bucket == "short" else (0.65 if bucket == "medium" else 0.82),
            "force_split_bucket": bucket == "long",
            "text_split_method": "cut0" if (bucket == "short" or text_units <= 18) else "cut5",
        }

    if text_units >= 60:
        limits["max_batch_size"] = min(int(limits["max_batch_size"]), 3 if tier == "roomy" else 2)
        limits["allow_parallel_infer"] = bool(limits["allow_parallel_infer"]) and tier in {"balanced", "roomy"}
    return {"tier": tier, "snapshot": snapshot, **limits}


def _apply_dynamic_single_profile(kwargs: dict, *, text: str) -> dict:
    adjusted = dict(kwargs or {})
    text_units = _estimate_text_unit_count(text)
    profile = _compute_gpt_sovits_dynamic_limits(_get_cached_gpu_snapshot(), text_units=text_units, bucket_name="short")
    adjusted["batch_size"] = min(max(1, int(adjusted.get("batch_size", 1) or 1)), int(profile["max_batch_size"]))
    adjusted["gpt_sovits_parallel_infer"] = bool(adjusted.get("gpt_sovits_parallel_infer", False)) and bool(profile["allow_parallel_infer"])
    adjusted["gpt_sovits_split_bucket"] = bool(profile["force_split_bucket"])
    adjusted["gpt_sovits_batch_threshold"] = min(
        float(adjusted.get("gpt_sovits_batch_threshold", 0.75) or 0.75),
        float(profile["max_batch_threshold"]),
    )
    adjusted["gpt_sovits_sample_steps"] = max(
        int(adjusted.get("gpt_sovits_sample_steps", 36) or 36),
        int(profile["min_sample_steps"]),
    )
    adjusted["gpt_sovits_text_split_method"] = str(profile["text_split_method"])
    return adjusted


def _apply_dynamic_batch_profile(kwargs: dict, *, bucket_name: str, text_units: int) -> tuple[dict, dict]:
    adjusted = dict(kwargs or {})
    profile = _compute_gpt_sovits_dynamic_limits(_get_cached_gpu_snapshot(), text_units=text_units, bucket_name=bucket_name)
    adjusted["batch_size"] = min(max(1, int(adjusted.get("batch_size", 1) or 1)), int(profile["max_batch_size"]))
    adjusted["gpt_sovits_parallel_infer"] = bool(adjusted.get("gpt_sovits_parallel_infer", False)) and bool(profile["allow_parallel_infer"])
    adjusted["gpt_sovits_split_bucket"] = bool(profile["force_split_bucket"])
    adjusted["gpt_sovits_batch_threshold"] = min(
        float(adjusted.get("gpt_sovits_batch_threshold", 0.75) or 0.75),
        float(profile["max_batch_threshold"]),
    )
    adjusted["gpt_sovits_sample_steps"] = max(
        int(adjusted.get("gpt_sovits_sample_steps", 36) or 36),
        int(profile["min_sample_steps"]),
    )
    adjusted["gpt_sovits_text_split_method"] = str(profile["text_split_method"])
    return adjusted, profile


def _is_oom_error_message(message: str) -> bool:
    normalized = str(message or "").lower()
    return (
        "cuda out of memory" in normalized
        or "cuda error: out of memory" in normalized
        or "torch.outofmemoryerror" in normalized
        or ("out of memory" in normalized and "cuda" in normalized)
    )


def _build_low_load_single_kwargs(kwargs: dict, text: str) -> dict:
    adjusted = _apply_dynamic_single_profile(apply_gpt_sovits_profile_defaults(kwargs), text=text)
    text_units = _estimate_text_unit_count(text)
    adjusted["batch_size"] = 1
    adjusted["gpt_sovits_parallel_infer"] = False
    adjusted["gpt_sovits_split_bucket"] = False
    adjusted["gpt_sovits_batch_threshold"] = min(float(adjusted.get("gpt_sovits_batch_threshold", 0.75) or 0.75), 0.30)
    adjusted["temperature"] = min(float(adjusted.get("temperature", 1.0) or 1.0), 0.80)
    adjusted["top_p"] = min(float(adjusted.get("top_p", 1.0) or 1.0), 0.90)
    adjusted["repetition_penalty"] = max(float(adjusted.get("repetition_penalty", 1.35) or 1.35), 1.28)
    adjusted["gpt_sovits_sample_steps"] = max(int(adjusted.get("gpt_sovits_sample_steps", 36) or 36), 40)
    adjusted["gpt_sovits_text_split_method"] = "cut0" if text_units <= 36 else str(adjusted.get("gpt_sovits_text_split_method") or "cut5")
    return adjusted


def _build_text_fidelity_single_kwargs(kwargs: dict, text: str, *, attempt: int) -> dict:
    adjusted = _apply_dynamic_single_profile(apply_gpt_sovits_profile_defaults(kwargs), text=text)
    text_units = _estimate_text_unit_count(text)
    acronym_letters = _count_acronym_letters(text)
    mixed_script = _is_mixed_script_text(text)
    short_sentence = text_units <= 24

    adjusted["batch_size"] = 1
    adjusted["gpt_sovits_parallel_infer"] = False
    adjusted["gpt_sovits_split_bucket"] = False
    adjusted["gpt_sovits_use_cuda_graph"] = bool(adjusted.get("gpt_sovits_use_cuda_graph", True))

    if mixed_script and short_sentence:
        adjusted["gpt_sovits_text_split_method"] = "cut0"
        adjusted["gpt_sovits_batch_threshold"] = min(float(adjusted.get("gpt_sovits_batch_threshold", 0.75) or 0.75), 0.24 if attempt > 1 else 0.28)
        adjusted["temperature"] = min(float(adjusted.get("temperature", 1.0) or 1.0), 0.68 if attempt > 1 else 0.74)
        adjusted["top_p"] = min(float(adjusted.get("top_p", 1.0) or 1.0), 0.84 if attempt > 1 else 0.90)
        adjusted["repetition_penalty"] = max(float(adjusted.get("repetition_penalty", 1.10) or 1.10), 1.10 if attempt == 1 else 1.14)
        adjusted["gpt_sovits_sample_steps"] = max(
            int(adjusted.get("gpt_sovits_sample_steps", 40) or 40),
            52 if acronym_letters >= 2 else 48,
        )
    elif short_sentence:
        adjusted["gpt_sovits_text_split_method"] = "cut0"
        adjusted["gpt_sovits_batch_threshold"] = min(float(adjusted.get("gpt_sovits_batch_threshold", 0.75) or 0.75), 0.30)
        adjusted["temperature"] = min(float(adjusted.get("temperature", 1.0) or 1.0), 0.78)
        adjusted["top_p"] = min(float(adjusted.get("top_p", 1.0) or 1.0), 0.92)
        adjusted["repetition_penalty"] = max(float(adjusted.get("repetition_penalty", 1.12) or 1.12), 1.12)
        adjusted["gpt_sovits_sample_steps"] = max(int(adjusted.get("gpt_sovits_sample_steps", 40) or 40), 44)

    return adjusted


def _build_low_load_batch_kwargs(kwargs: dict) -> dict:
    adjusted, _ = _apply_dynamic_batch_profile(apply_gpt_sovits_profile_defaults(kwargs), bucket_name="short", text_units=12)
    adjusted["batch_size"] = 1
    adjusted["gpt_sovits_parallel_infer"] = False
    adjusted["gpt_sovits_split_bucket"] = False
    adjusted["gpt_sovits_batch_threshold"] = min(float(adjusted.get("gpt_sovits_batch_threshold", 0.75) or 0.75), 0.28)
    adjusted["temperature"] = min(float(adjusted.get("temperature", 1.0) or 1.0), 0.80)
    adjusted["top_p"] = min(float(adjusted.get("top_p", 1.0) or 1.0), 0.90)
    adjusted["repetition_penalty"] = max(float(adjusted.get("repetition_penalty", 1.35) or 1.35), 1.28)
    adjusted["gpt_sovits_sample_steps"] = max(int(adjusted.get("gpt_sovits_sample_steps", 36) or 36), 40)
    adjusted["gpt_sovits_text_split_method"] = "cut0"
    return adjusted


def resolve_builtin_reference(ref_audio_path: str | None, prompt_text: str | None, prompt_lang: str | None) -> tuple[str | None, str | None, str | None]:
    key = str(ref_audio_path or "").strip()
    config = BUILTIN_GPT_SOVITS_REFS.get(key)
    if not config:
        return ref_audio_path, prompt_text, prompt_lang

    resolved_path = _project_root().joinpath(*config["path"])
    if not resolved_path.exists():
        raise RuntimeError(f"内置 GPT-SoVITS 参考音频缺失: {resolved_path}")

    resolved_prompt_text = str(prompt_text or "").strip() or str(config["prompt_text"])
    resolved_prompt_lang = str(prompt_lang or "").strip() or str(config["prompt_lang"])
    return str(resolved_path), resolved_prompt_text, resolved_prompt_lang


def _normalize_output_loudness(audio_path: str) -> float | None:
    try:
        audio, sample_rate = sf.read(audio_path, always_2d=False)
        audio = np.asarray(audio, dtype=np.float32)
        if audio.size == 0:
            return None
        if audio.ndim > 1:
            audio = np.mean(audio, axis=1)

        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        if peak <= 1e-6:
            return None

        mask = np.abs(audio) > 0.003
        active = audio[mask] if np.any(mask) else audio
        if active.size == 0:
            return None

        active_rms = float(np.sqrt(np.mean(np.square(active))))
        if active_rms <= 1e-6:
            return None

        target_rms = 0.11
        gain = target_rms / active_rms
        max_gain = 0.92 / peak
        gain = max(0.75, min(gain, max_gain, 3.0))
        if abs(gain - 1.0) < 0.04:
            return gain

        normalized = np.clip(audio * gain, -0.92, 0.92)
        sf.write(audio_path, normalized, sample_rate)
        return gain
    except Exception:
        return None


def _validate_gpt_sovits_duration(audio_path: str, text: str) -> float:
    duration = _validate_output(audio_path)
    text_units = _estimate_text_unit_count(text)
    if text_units <= 0:
        return duration

    minimum_expected = 0.0
    if text_units <= 2:
        minimum_expected = 0.18
    elif text_units <= 5:
        minimum_expected = max(0.24, text_units * 0.06)
    else:
        minimum_expected = min(3.2, max(0.28, text_units * 0.038))

    acronym_letters = _count_acronym_letters(text)
    if acronym_letters > 0:
        minimum_expected += min(0.40, acronym_letters * 0.07)
    if _is_mixed_script_text(text) and text_units <= 24:
        minimum_expected += 0.10

    if duration < minimum_expected:
        raise RuntimeError(
            f"GPT-SoVITS 输出时长异常偏短 ({duration:.2f}s < {minimum_expected:.2f}s, text_units={text_units})"
        )
    return duration


def _recover_low_level_output(audio_path: str) -> float | None:
    try:
        audio, sample_rate = sf.read(audio_path, always_2d=False)
        audio = np.asarray(audio, dtype=np.float32)
        if audio.size == 0:
            return None

        if audio.ndim > 1:
            audio = np.mean(audio, axis=1)

        duration = float(audio.shape[0]) / float(sample_rate or 1)
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
        non_silent_ratio = float(np.mean(np.abs(audio) > 0.001)) if audio.size else 0.0

        if duration < 0.12 or peak <= 0.001 or non_silent_ratio < 0.02:
            return None

        gain = min(12.0, max(1.0, 0.12 / peak))
        if gain <= 1.05:
            return None

        boosted = np.clip(audio * gain, -0.98, 0.98)
        sf.write(audio_path, boosted, sample_rate)
        ok, _ = validate_generated_audio(audio_path)
        if not ok:
            return None

        log_business(
            logger,
            logging.WARNING,
            "Recovered low-level GPT-SoVITS output by gain normalization",
            event="gpt_sovits_output_recovered",
            stage="tts_generate",
            detail=(
                f"path={Path(audio_path).name} duration={duration:.3f}s "
                f"peak={peak:.6f} rms={rms:.6f} non_silent_ratio={non_silent_ratio:.4f} gain={gain:.2f}"
            ),
        )
        return float(sf.info(audio_path).duration)
    except Exception:
        return None


def run_gpt_sovits_tts(text, ref_audio_path, output_path, language="English", **kwargs):
    _start_server()
    _begin_real_request()
    success = False
    try:
        success = bool(_run_gpt_sovits_request(text, ref_audio_path, output_path, language=language, **kwargs))
        return success
    finally:
        _end_real_request(success=success)


def _run_gpt_sovits_request(text, ref_audio_path, output_path, language="English", **kwargs):
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    source_text = str(text or "")
    synth_text = _normalize_gpt_sovits_text(source_text, language=str(language or "English"))
    effective_kwargs = _apply_dynamic_single_profile(apply_gpt_sovits_profile_defaults(kwargs), text=synth_text)
    if synth_text != source_text:
        log_business(
            logger,
            logging.INFO,
            "Normalized GPT-SoVITS synthesis text",
            event="gpt_sovits_text_normalized",
            stage="tts_generate",
            detail=f"source={source_text} normalized={synth_text}",
        )
    last_error = None
    for attempt in range(1, 3):
        attempt_kwargs = dict(effective_kwargs)
        if _is_mixed_script_text(synth_text) or _count_acronym_letters(synth_text) > 0 or _estimate_text_unit_count(synth_text) <= 24:
            attempt_kwargs = _build_text_fidelity_single_kwargs(attempt_kwargs, synth_text, attempt=attempt)
        payload = _build_request_payload(synth_text, str(ref_audio_path or ""), str(language or "English"), attempt_kwargs)
        snapshot = _get_cached_gpu_snapshot()
        profile = _compute_gpt_sovits_dynamic_limits(snapshot, text_units=_estimate_text_unit_count(synth_text), bucket_name="short")
        log_business(
            logger,
            logging.INFO,
            "Dispatching GPT-SoVITS request",
            event="gpt_sovits_request",
            stage="tts_generate",
            detail=(
                f"attempt={attempt} tier={profile.get('tier')} "
                f"free={float((snapshot or {}).get('free_gb') or 0.0):.2f}GB "
                f"total={float((snapshot or {}).get('total_gb') or 0.0):.2f}GB "
                f"{_summarize_request_payload(payload)}"
            ),
        )
        request = urllib.request.Request(
            f"http://127.0.0.1:{_SERVER_PORT}/tts",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=600) as response, output.open("wb") as handle:
                shutil.copyfileobj(response, handle)
            gain = _normalize_output_loudness(str(output))
            if gain is not None:
                log_business(
                    logger,
                    logging.INFO,
                    "Normalized GPT-SoVITS output loudness",
                    event="gpt_sovits_output_loudness_normalized",
                    stage="tts_generate",
                    detail=f"path={output.name} gain={gain:.3f}",
                )
            _validate_gpt_sovits_duration(str(output), synth_text)
            coverage = _verify_gpt_sovits_text_fidelity(str(output), synth_text, language=str(language or "English"))
            if coverage < 1.0:
                log_business(
                    logger,
                    logging.INFO,
                    "Verified GPT-SoVITS text fidelity",
                    event="gpt_sovits_text_fidelity_verified",
                    stage="tts_generate",
                    detail=f"path={output.name} coverage={coverage:.2f}",
                )
            return True
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            last_error = (
                "GPT-SoVITS 请求失败: "
                f"HTTP {error.code} body={body} "
                f"{_summarize_request_payload(payload)}"
            )
            if attempt == 1 and _is_oom_error_message(body):
                log_business(
                    logger,
                    logging.WARNING,
                    "Restarting GPT-SoVITS server after CUDA OOM",
                    event="gpt_sovits_restart_after_oom",
                    stage="tts_generate",
                    detail=_summarize_request_payload(payload),
                )
                _stop_server()
                _start_server()
                effective_kwargs = _build_low_load_single_kwargs(effective_kwargs, synth_text)
                continue
            raise RuntimeError(last_error) from error
        except Exception as error:
            last_error = str(error)
            if attempt == 1 and _is_text_fidelity_error_message(last_error):
                log_business(
                    logger,
                    logging.WARNING,
                    "Retrying GPT-SoVITS request after text fidelity verification failure",
                    event="gpt_sovits_retry_after_text_fidelity_failure",
                    stage="tts_generate",
                    detail=last_error,
                )
                continue
            if attempt == 1 and _is_oom_error_message(last_error):
                log_business(
                    logger,
                    logging.WARNING,
                    "Restarting GPT-SoVITS server after CUDA OOM",
                    event="gpt_sovits_restart_after_oom",
                    stage="tts_generate",
                    detail=_summarize_request_payload(payload),
                )
                _stop_server()
                _start_server()
                effective_kwargs = _build_low_load_single_kwargs(effective_kwargs, synth_text)
                continue
            raise

    raise RuntimeError(last_error or "GPT-SoVITS request failed")


def _group_batch_tasks(tasks: list[dict], *, language: str, base_kwargs: dict) -> list[dict]:
    base_kwargs = apply_gpt_sovits_profile_defaults(base_kwargs)
    groups: dict[tuple[str, str, str, str], dict] = {}
    for task in tasks:
        ref_audio_path = str(task.get("ref_audio_path") or "")
        prompt_text = str(task.get("ref_text") or base_kwargs.get("gpt_sovits_prompt_text") or "")
        prompt_lang = str(base_kwargs.get("gpt_sovits_prompt_lang") or language or "")
        task_language = str(language or "")
        group_key = (ref_audio_path, prompt_text, prompt_lang, task_language)
        group = groups.get(group_key)
        if group is None:
            group = {
                "ref_audio_path": ref_audio_path,
                "prompt_text": prompt_text,
                "prompt_lang": prompt_lang,
                "language": task_language,
                "items": [],
            }
            groups[group_key] = group
        group["items"].append(
            {
                "index": task.get("index"),
                "text": str(task.get("text") or ""),
                "output_path": str(task.get("output_path") or ""),
            }
        )

    def classify_bucket(text: str) -> str:
        text_units = _estimate_text_unit_count(text)
        if text_units <= 10:
            return "short"
        if text_units <= 28:
            return "medium"
        return "long"

    profile_id = _resolve_gpt_sovits_profile_id(base_kwargs)
    official_fast_mode = bool(base_kwargs.get("gpt_sovits_official_fast_mode", False))
    requested_batch_size = min(12 if official_fast_mode else (6 if profile_id == "quality" else 8), max(1, int(base_kwargs.get("batch_size", 4) or 4)))
    expanded_groups: list[dict] = []
    for group in groups.values():
        normalized_ref = str(group.get("ref_audio_path") or "").replace("\\", "/").lower()
        official_fast_lane = (
            official_fast_mode
            and bool(group.get("ref_audio_path"))
            and bool(group.get("prompt_text"))
            and str(base_kwargs.get("voice_mode") or "").strip().lower() == "narration"
            and "voice_refs/gpt_sovits/" in normalized_ref
        )
        if official_fast_lane:
            bucketed_items: dict[str, list[dict]] = {"official_fast": list(group["items"])}
        else:
            bucketed_items = {"short": [], "medium": [], "long": []}
            for item in group["items"]:
                bucketed_items[classify_bucket(item.get("text", ""))].append(item)

        for bucket_name, bucket_items in bucketed_items.items():
            if not bucket_items:
                continue
            sample_text_units = max((_estimate_text_unit_count(item.get("text", "")) for item in bucket_items), default=0)
            dynamic_seed, profile = _apply_dynamic_batch_profile(
                dict(base_kwargs),
                bucket_name="medium" if bucket_name == "official_fast" else bucket_name,
                text_units=sample_text_units,
            )
            normalized_ref = str(group.get("ref_audio_path") or "").replace("\\", "/").lower()
            shared_reference_fast_path = (
                bucket_name == "short"
                and bool(group.get("ref_audio_path"))
                and bool(group.get("prompt_text"))
                and str(base_kwargs.get("voice_mode") or "").strip().lower() == "narration"
                and profile.get("tier") in {"balanced", "roomy"}
                and (
                    "voice_refs/gpt_sovits/" in normalized_ref
                    or len(bucket_items) >= 4
                )
            )
            if bucket_name == "official_fast":
                snapshot = profile.get("snapshot") or {}
                free_gb = float(snapshot.get("free_gb", 0.0) or 0.0)
                total_gb = float(snapshot.get("total_gb", 0.0) or 0.0)
                free_ratio = (free_gb / total_gb) if total_gb > 0 else 0.0
                fast_cap = (
                    6 if profile.get("tier") == "balanced"
                    else 12 if profile.get("tier") == "roomy"
                    else 6
                )
                learned_cap = _get_learned_official_fast_batch_cap(
                    gpu_tier=str(profile.get("tier") or "unknown"),
                    voice_mode=str(base_kwargs.get("voice_mode") or "narration"),
                )
                if learned_cap is not None:
                    fast_cap = min(fast_cap, learned_cap)
                chunk_size = min(requested_batch_size, max(int(profile["max_batch_size"]), fast_cap))
                payload_overrides = {
                    "batch_size": chunk_size,
                    "gpt_sovits_batch_threshold": max(0.8, float(base_kwargs.get("gpt_sovits_batch_threshold", 1.2) or 1.2)),
                    "gpt_sovits_parallel_infer": True,
                    "gpt_sovits_split_bucket": False,
                    "gpt_sovits_sample_steps": 28,
                    "temperature": float(base_kwargs.get("temperature", 1.0) or 1.0),
                    "top_p": float(base_kwargs.get("top_p", 1.0) or 1.0),
                    "repetition_penalty": max(float(base_kwargs.get("repetition_penalty", 1.35) or 1.35), 1.16),
                    "gpt_sovits_text_split_method": "cut0",
                    "gpt_sovits_official_fast_mode": True,
                }
            elif bucket_name == "short":
                if shared_reference_fast_path:
                    fast_cap = (
                        6 if (official_fast_mode and profile.get("tier") == "balanced")
                        else 8 if official_fast_mode
                        else 4 if profile.get("tier") == "balanced"
                        else 6
                    )
                    chunk_size = min(requested_batch_size, max(int(profile["max_batch_size"]), fast_cap))
                    payload_overrides = {
                        "batch_size": chunk_size,
                        "gpt_sovits_batch_threshold": max(0.8, float(base_kwargs.get("gpt_sovits_batch_threshold", 1.2) or 1.2)) if official_fast_mode else min(float(dynamic_seed.get("gpt_sovits_batch_threshold", 0.75) or 0.75), 0.55),
                        "gpt_sovits_parallel_infer": True,
                        "gpt_sovits_split_bucket": False,
                        "gpt_sovits_sample_steps": 28 if official_fast_mode else 32,
                        "temperature": float(base_kwargs.get("temperature", 1.0) or 1.0) if official_fast_mode else min(float(base_kwargs.get("temperature", 1.0) or 1.0), 0.90),
                        "top_p": float(base_kwargs.get("top_p", 1.0) or 1.0) if official_fast_mode else min(float(base_kwargs.get("top_p", 1.0) or 1.0), 0.95),
                        "repetition_penalty": max(float(base_kwargs.get("repetition_penalty", 1.35) or 1.35), 1.16 if official_fast_mode else 1.20),
                        "gpt_sovits_text_split_method": "cut0",
                        "gpt_sovits_official_fast_mode": official_fast_mode,
                    }
                else:
                    chunk_size = min(requested_batch_size, int(profile["max_batch_size"]))
                    payload_overrides = {
                        "batch_size": chunk_size,
                        "gpt_sovits_batch_threshold": min(float(dynamic_seed.get("gpt_sovits_batch_threshold", 0.75) or 0.75), 0.30 if profile_id == "quality" else 0.35),
                        "gpt_sovits_parallel_infer": False,
                        "gpt_sovits_split_bucket": False,
                        "gpt_sovits_sample_steps": max(44 if profile_id == "quality" else 40, int(dynamic_seed.get("gpt_sovits_sample_steps", 36) or 36)),
                        "temperature": min(float(base_kwargs.get("temperature", 1.0) or 1.0), 0.78 if profile_id == "quality" else 0.82),
                        "top_p": min(float(base_kwargs.get("top_p", 1.0) or 1.0), 0.90 if profile_id == "quality" else 0.92),
                        "repetition_penalty": max(float(base_kwargs.get("repetition_penalty", 1.35) or 1.35), 1.26 if profile_id == "quality" else 1.22),
                        "gpt_sovits_text_split_method": str(dynamic_seed.get("gpt_sovits_text_split_method") or "cut0"),
                        "gpt_sovits_official_fast_mode": official_fast_mode,
                    }
            elif bucket_name == "medium":
                chunk_size = min(requested_batch_size, int(profile["max_batch_size"]))
                payload_overrides = {
                    "batch_size": chunk_size,
                    "gpt_sovits_batch_threshold": min(float(dynamic_seed.get("gpt_sovits_batch_threshold", 0.75) or 0.75), 0.45 if profile_id == "quality" else 0.55),
                    "gpt_sovits_parallel_infer": False if profile_id == "quality" else bool(dynamic_seed.get("gpt_sovits_parallel_infer", False)),
                    "gpt_sovits_split_bucket": bool(dynamic_seed.get("gpt_sovits_split_bucket", False)),
                    "gpt_sovits_sample_steps": max(44 if profile_id == "quality" else 36, int(dynamic_seed.get("gpt_sovits_sample_steps", 36) or 36)),
                    "temperature": min(float(base_kwargs.get("temperature", 1.0) or 1.0), 0.80 if profile_id == "quality" else 0.88),
                    "top_p": min(float(base_kwargs.get("top_p", 1.0) or 1.0), 0.90 if profile_id == "quality" else 0.95),
                    "repetition_penalty": max(float(base_kwargs.get("repetition_penalty", 1.35) or 1.35), 1.26 if profile_id == "quality" else 1.22),
                    "gpt_sovits_text_split_method": str(dynamic_seed.get("gpt_sovits_text_split_method") or "cut5"),
                    "gpt_sovits_official_fast_mode": official_fast_mode,
                }
            else:
                chunk_size = min(requested_batch_size, int(profile["max_batch_size"]))
                payload_overrides = {
                    "batch_size": chunk_size,
                    "gpt_sovits_batch_threshold": min(float(dynamic_seed.get("gpt_sovits_batch_threshold", 0.75) or 0.75), 0.58 if profile_id == "quality" else 0.75),
                    "gpt_sovits_parallel_infer": False if profile_id == "quality" else bool(dynamic_seed.get("gpt_sovits_parallel_infer", False)),
                    "gpt_sovits_split_bucket": bool(dynamic_seed.get("gpt_sovits_split_bucket", True)),
                    "gpt_sovits_sample_steps": max(40 if profile_id == "quality" else 32, int(dynamic_seed.get("gpt_sovits_sample_steps", 36) or 36)),
                    "temperature": min(float(base_kwargs.get("temperature", 1.0) or 1.0), 0.84 if profile_id == "quality" else 0.92),
                    "top_p": min(float(base_kwargs.get("top_p", 1.0) or 1.0), 0.92 if profile_id == "quality" else 0.98),
                    "repetition_penalty": max(float(base_kwargs.get("repetition_penalty", 1.35) or 1.35), 1.24 if profile_id == "quality" else 1.18),
                    "gpt_sovits_text_split_method": str(dynamic_seed.get("gpt_sovits_text_split_method") or "cut5"),
                    "gpt_sovits_official_fast_mode": official_fast_mode,
                }

            for start in range(0, len(bucket_items), chunk_size):
                expanded_group = dict(group)
                expanded_group["items"] = bucket_items[start:start + chunk_size]
                expanded_group["quality_bucket"] = bucket_name
                expanded_group["payload_overrides"] = payload_overrides
                expanded_group["gpu_tier"] = profile.get("tier")
                expanded_groups.append(expanded_group)

    return expanded_groups


def _run_batch_gpt_sovits_request(group: dict, *, base_kwargs: dict) -> list[dict]:
    effective_kwargs = dict(base_kwargs)
    effective_kwargs.update(group.get("payload_overrides") or {})
    group_items = list(group.get("items") or [])
    group_size = len(group_items)
    group_gpu_tier = str(group.get("gpu_tier") or "unknown")
    voice_mode = str(base_kwargs.get("voice_mode") or "narration")
    last_error = None
    for attempt in range(1, 3):
        payload = _build_request_payload("", str(group.get("ref_audio_path") or ""), str(group.get("language") or "English"), effective_kwargs)
        payload["prompt_text"] = str(group.get("prompt_text") or "")
        payload["prompt_lang"] = _map_language(str(group.get("prompt_lang") or group.get("language") or "English"), allow_auto=True)
        payload["items"] = list(group.get("items") or [])
        payload["text"] = str((payload["items"][0] or {}).get("text") or "__batch__")
        log_business(
            logger,
            logging.INFO,
            "Dispatching GPT-SoVITS batch request",
            event="gpt_sovits_batch_request",
            stage="tts_generate",
            detail=(
                f"attempt={attempt} tier={group.get('gpu_tier') or 'unknown'} "
                f"items={len(payload['items'])} ref={Path(str(payload.get('ref_audio_path') or '')).name} "
                f"prompt_len={len(str(payload.get('prompt_text') or ''))} batch_size={payload.get('batch_size')} "
                f"bucket={group.get('quality_bucket') or 'default'}"
            ),
        )
        request = urllib.request.Request(
            f"http://127.0.0.1:{_SERVER_PORT}/tts_batch",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=1800) as response:
                body = response.read().decode("utf-8", errors="replace")
                decoded = json.loads(body) if body.strip() else {}
            results = decoded.get("results")
            if not isinstance(results, list):
                raise RuntimeError("GPT-SoVITS 批量请求未返回 results 列表。")
            return results
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            last_error = f"GPT-SoVITS 批量请求失败: HTTP {error.code} body={body} items={len(payload['items'])}"
            if attempt == 1 and _is_oom_error_message(body):
                if bool(effective_kwargs.get("gpt_sovits_official_fast_mode", False)) and len(payload["items"]) > 1:
                    _remember_official_fast_batch_cap(
                        gpu_tier=group_gpu_tier,
                        voice_mode=voice_mode,
                        batch_size=max(1, len(payload["items"]) // 2),
                    )
                log_business(
                    logger,
                    logging.WARNING,
                    "Restarting GPT-SoVITS batch server after CUDA OOM",
                    event="gpt_sovits_batch_restart_after_oom",
                    stage="batch_tts",
                    detail=f"items={len(payload['items'])} bucket={group.get('quality_bucket') or 'default'}",
                )
                _stop_server()
                _start_server()
                if len(payload["items"]) > 2:
                    midpoint = max(1, len(payload["items"]) // 2)
                    left_group = dict(group)
                    right_group = dict(group)
                    left_group["items"] = list(payload["items"][:midpoint])
                    right_group["items"] = list(payload["items"][midpoint:])
                    merged_results: list[dict] = []
                    merged_results.extend(_run_batch_gpt_sovits_request(left_group, base_kwargs=effective_kwargs))
                    merged_results.extend(_run_batch_gpt_sovits_request(right_group, base_kwargs=effective_kwargs))
                    return merged_results
                effective_kwargs = _build_low_load_batch_kwargs(effective_kwargs)
                continue
            raise RuntimeError(last_error) from error
        except Exception as error:
            last_error = str(error)
            if attempt == 1 and _is_oom_error_message(last_error):
                if bool(effective_kwargs.get("gpt_sovits_official_fast_mode", False)) and len(group.get("items") or []) > 1:
                    _remember_official_fast_batch_cap(
                        gpu_tier=group_gpu_tier,
                        voice_mode=voice_mode,
                        batch_size=max(1, len(group.get("items") or []) // 2),
                    )
                log_business(
                    logger,
                    logging.WARNING,
                    "Restarting GPT-SoVITS batch server after CUDA OOM",
                    event="gpt_sovits_batch_restart_after_oom",
                    stage="batch_tts",
                    detail=f"items={len(group.get('items') or [])} bucket={group.get('quality_bucket') or 'default'}",
                )
                _stop_server()
                _start_server()
                if len(group.get("items") or []) > 2:
                    split_items = list(group.get("items") or [])
                    midpoint = max(1, len(split_items) // 2)
                    left_group = dict(group)
                    right_group = dict(group)
                    left_group["items"] = split_items[:midpoint]
                    right_group["items"] = split_items[midpoint:]
                    merged_results: list[dict] = []
                    merged_results.extend(_run_batch_gpt_sovits_request(left_group, base_kwargs=effective_kwargs))
                    merged_results.extend(_run_batch_gpt_sovits_request(right_group, base_kwargs=effective_kwargs))
                    return merged_results
                effective_kwargs = _build_low_load_batch_kwargs(effective_kwargs)
                continue
            raise

    raise RuntimeError(last_error or "GPT-SoVITS batch request failed")


def _should_emit_official_fast_progress(*, completed: int, progress_total: int, group_size: int, success: bool) -> bool:
    if not success:
        return True
    if progress_total <= 0 or completed >= progress_total:
        return True
    checkpoint = max(8, min(16, max(1, int(group_size or 1))))
    return (completed % checkpoint) == 0


def run_batch_gpt_sovits_tts(tasks, language="English", **kwargs) -> Generator[dict, None, None]:
    total = len(tasks)
    _start_server()
    _begin_real_request()
    progress_completed_offset = max(int(kwargs.get("progress_completed_offset", 0) or 0), 0)
    progress_total_override = max(int(kwargs.get("progress_total_override", 0) or 0), 0)
    progress_total = max(progress_total_override, progress_completed_offset + total, total)
    emit_stage(
        "generate_batch_tts",
        "tts_generate",
        f"正在生成 {progress_total} 条 GPT-SoVITS 配音",
        stage_label="正在生成配音",
    )

    completed = 0
    encountered_success = False
    grouped_tasks = _group_batch_tasks(list(tasks), language=language, base_kwargs=dict(kwargs))
    try:
        for group in grouped_tasks:
            try:
                group_official_fast = bool((group.get("payload_overrides") or {}).get("gpt_sovits_official_fast_mode", False))
                next_position = min(progress_completed_offset + completed + 1, progress_total) if progress_total else (completed + 1)
                if (not group_official_fast) or completed <= 0:
                    emit_progress(
                        "generate_batch_tts",
                        "tts_generate",
                        int(((next_position - 1) / progress_total) * 100) if progress_total else 0,
                        f"第 {next_position}/{progress_total} 条生成中",
                        stage_label="正在生成配音",
                        item_index=next_position,
                        item_total=progress_total,
                        detail=(
                            f"参考音频: {Path(str(group.get('ref_audio_path') or '')).name}"
                            if len(group.get("items") or []) <= 1
                            else f"批量 {len(group.get('items') or [])} 条"
                        ),
                    )
                group_started_at = time.perf_counter()
                group_results = _run_batch_gpt_sovits_request(group, base_kwargs=dict(kwargs))
                group_elapsed_ms = (time.perf_counter() - group_started_at) * 1000.0
                if (not group_official_fast) or len(group.get("items") or []) >= 8:
                    print(
                        f"[TTSTiming] mode=gpt_sovits_true_batch total={group_elapsed_ms:.0f}ms "
                        f"items={len(group.get('items') or [])}"
                    )
                for result in group_results:
                    completed += 1
                    display_position = min(progress_completed_offset + completed, progress_total) if progress_total else completed
                    if result.get("success") and result.get("audio_path"):
                        task_text = next(
                            (
                                str(item.get("text") or "")
                                for item in group.get("items") or []
                                if int(item.get("index")) == int(result.get("index"))
                            ),
                            "",
                        )
                        if group_official_fast:
                            result["duration"] = float(result.get("duration") or 0.0)
                        else:
                            result["duration"] = _validate_gpt_sovits_duration(str(result.get("audio_path")), task_text)
                    emit_partial_result("generate_batch_tts", result)
                    encountered_success = encountered_success or bool(result.get("success"))
                    should_emit_completion_progress = (
                        not group_official_fast
                        or _should_emit_official_fast_progress(
                            completed=display_position,
                            progress_total=progress_total,
                            group_size=len(group.get("items") or []),
                            success=bool(result.get("success")),
                        )
                    )
                    if should_emit_completion_progress:
                        emit_progress(
                            "generate_batch_tts",
                            "tts_generate",
                            int((display_position / progress_total) * 100) if progress_total else 100,
                            f"第 {display_position}/{progress_total} 条已完成" if result.get("success") else f"第 {display_position}/{progress_total} 条失败",
                            stage_label="正在生成配音",
                            item_index=display_position,
                            item_total=progress_total,
                            detail=None if result.get("success") else str(result.get("error") or ""),
                        )
                    yield result
            except Exception as error:
                log_error(logger, "GPT-SoVITS batch synthesis failed", event="gpt_sovits_batch_failed", stage="batch_tts", detail=str(error))
                for failed_item in group.get("items") or []:
                    completed += 1
                    display_position = min(progress_completed_offset + completed, progress_total) if progress_total else completed
                    result = {
                        "index": failed_item.get("index"),
                        "success": False,
                        "error": str(error),
                    }
                    emit_partial_result("generate_batch_tts", result)
                    emit_progress(
                        "generate_batch_tts",
                        "tts_generate",
                        int((display_position / progress_total) * 100) if progress_total else 100,
                        f"第 {display_position}/{progress_total} 条失败",
                        stage_label="正在生成配音",
                        item_index=display_position,
                        item_total=progress_total,
                        detail=str(error),
                    )
                    yield result
    finally:
        _end_real_request(success=encountered_success)
