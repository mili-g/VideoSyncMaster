from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import sys
from typing import Any


CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from bootstrap.path_layout import get_project_root, get_runtime_overlay_dir, get_runtime_python_dir, get_storage_cache_dir, get_storage_runtime_dir


PROJECT_ROOT = get_project_root(CURRENT_DIR)
_CACHE_DIR = get_storage_cache_dir(PROJECT_ROOT)
_RUNTIME_DIR = get_storage_runtime_dir(PROJECT_ROOT)
_OFFLOAD_ROOT = os.path.join(_CACHE_DIR, "transformers5_asr_offload")
PREFERRED_OVERLAY_DIR = get_runtime_overlay_dir(PROJECT_ROOT, "transformers5_asr")
LEGACY_OVERLAY_DIRS = [
    os.path.join(_RUNTIME_DIR, "transformers5_asr"),
    os.path.join(_CACHE_DIR, "transformers5_asr_overlay"),
]
OVERLAY_DIR = PREFERRED_OVERLAY_DIR
if not os.path.isdir(OVERLAY_DIR):
    for _legacy_dir in LEGACY_OVERLAY_DIRS:
        if os.path.isdir(_legacy_dir):
            OVERLAY_DIR = _legacy_dir
            break
RUNTIME_SITE_PACKAGES = os.path.join(get_runtime_python_dir(PROJECT_ROOT), "Lib", "site-packages")


def _prepend_runtime_paths() -> None:
    for candidate in [RUNTIME_SITE_PACKAGES, CURRENT_DIR]:
        if candidate and os.path.isdir(candidate) and candidate not in sys.path:
            sys.path.insert(0, candidate)


_prepend_runtime_paths()

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def _extend_cuda_runtime_paths() -> None:
    candidate_dirs = [
        os.path.join(RUNTIME_SITE_PACKAGES, "nvidia", "cudnn", "bin"),
        os.path.join(RUNTIME_SITE_PACKAGES, "nvidia", "cublas", "bin"),
        os.path.join(RUNTIME_SITE_PACKAGES, "nvidia", "cuda_runtime", "bin"),
        os.path.join(RUNTIME_SITE_PACKAGES, "nvidia", "cuda_nvrtc", "bin"),
        os.path.join(RUNTIME_SITE_PACKAGES, "torch", "lib"),
    ]
    existing_dirs = [candidate for candidate in candidate_dirs if os.path.isdir(candidate)]
    if existing_dirs:
        os.environ["PATH"] = os.pathsep.join([*existing_dirs, os.environ.get("PATH", "")])
    if os.name == "nt":
        for candidate in existing_dirs:
            try:
                os.add_dll_directory(candidate)
            except (AttributeError, FileNotFoundError, OSError):
                continue


_extend_cuda_runtime_paths()

import librosa
import torch


def _import_transformers5_module():
    overlay_dir = OVERLAY_DIR
    if not os.path.isdir(overlay_dir):
        raise RuntimeError(f"Transformers 5.x overlay runtime directory is missing: {overlay_dir}")

    if overlay_dir in sys.path:
        sys.path.remove(overlay_dir)
    sys.path.insert(0, overlay_dir)

    for module_name in ["transformers"]:
        if module_name in sys.modules:
            del sys.modules[module_name]

    return importlib.import_module("transformers")


def _select_device(requested: str) -> str:
    normalized = str(requested or "auto").strip().lower()
    if normalized == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested but is not available in the current runtime.")
        return "cuda"
    if normalized == "cpu":
        return "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"


def _load_audio(audio_path: str, sample_rate: int) -> tuple[Any, int]:
    audio, sample_rate = librosa.load(audio_path, sr=sample_rate, mono=False)
    if getattr(audio, "ndim", 1) > 1:
        audio = audio.mean(axis=0)
    return audio, int(sample_rate)


def _decode_glm_output(processor: Any, generated_ids: Any) -> str:
    decoded = ""
    for candidate in [
        lambda: processor.batch_decode(generated_ids, skip_special_tokens=True)[0],
        lambda: processor.decode(generated_ids[0], skip_special_tokens=True),
        lambda: processor.decode(generated_ids[0]),
    ]:
        try:
            value = candidate()
        except Exception:
            continue
        decoded = str(value or "").strip()
        if decoded:
            break
    return decoded


def _extract_generated_continuation(output_ids: Any, inputs: dict[str, Any]) -> Any:
    input_ids = inputs.get("input_ids")
    if input_ids is None:
        return output_ids

    prompt_length = None
    shape = getattr(input_ids, "shape", None)
    if shape and len(shape) >= 2:
        prompt_length = int(shape[1])
    elif shape and len(shape) == 1:
        prompt_length = int(shape[0])

    if prompt_length is None or prompt_length <= 0:
        return output_ids

    try:
        return output_ids[:, prompt_length:]
    except Exception:
        return output_ids


def _normalize_segment(segment: dict[str, Any]) -> dict[str, Any] | None:
    text = str(
        segment.get("text")
        or segment.get("content")
        or segment.get("Content")
        or ""
    ).strip()
    start = segment.get("start", segment.get("Start", 0.0))
    end = segment.get("end", segment.get("End", start))
    try:
        start_value = round(float(start or 0.0), 3)
        end_value = round(float(end if end is not None else start_value), 3)
    except Exception:
        return None
    if end_value < start_value:
        end_value = start_value
    normalized = {
        "start": start_value,
        "end": end_value,
        "text": text,
    }
    for key in ["speaker", "speaker_id", "utterance", "utterance_id", "utterance_index", "provider", "provider_meta"]:
        if key in segment and segment.get(key) is not None:
            normalized[key] = segment.get(key)
    if "Speaker" in segment and segment.get("Speaker") is not None and "speaker" not in normalized:
        normalized["speaker"] = segment.get("Speaker")
    return normalized


def _segments_from_json_payload(decoded_text: str) -> list[dict[str, Any]] | None:
    candidate = str(decoded_text or "").strip()
    if not candidate:
        return []

    def extract_json_block(source: str) -> str | None:
        stack: list[str] = []
        start_index = -1
        pairs = {"[": "]", "{": "}"}
        closers = {"]", "}"}
        for index, char in enumerate(source):
            if char in pairs:
                if start_index == -1:
                    start_index = index
                stack.append(pairs[char])
                continue
            if char in closers and stack:
                expected = stack.pop()
                if char != expected:
                    return None
                if not stack and start_index != -1:
                    return source[start_index:index + 1]
        return None

    payload_text = extract_json_block(candidate)
    if not payload_text:
        return None

    try:
        payload = json.loads(payload_text)
    except json.JSONDecodeError:
        return None

    if isinstance(payload, dict):
        for key in ["segments", "utterances", "result", "data"]:
            nested = payload.get(key)
            if isinstance(nested, list):
                payload = nested
                break

    if not isinstance(payload, list):
        return None

    normalized = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        segment = _normalize_segment(item)
        if segment is not None:
            normalized.append(segment)
    return normalized


def _segments_from_content_fields(decoded_text: str, duration: float) -> list[dict[str, Any]] | None:
    candidate = str(decoded_text or "").strip()
    if not candidate:
        return []

    matches = re.findall(r'"Content"\s*:\s*"((?:\\.|[^"])*)"', candidate)
    if not matches:
        return None

    contents = []
    for match in matches:
        try:
            contents.append(json.loads(f'"{match}"'))
        except json.JSONDecodeError:
            contents.append(match)

    joined = " ".join(str(item or "").strip() for item in contents if str(item or "").strip()).strip()
    if not joined:
        return []
    return [{
        "start": 0.0,
        "end": round(float(duration or 0.0), 3),
        "text": joined,
    }]


def _clean_vibevoice_fallback_text(decoded_text: str) -> str:
    candidate = str(decoded_text or "").strip()
    if not candidate:
        return ""
    candidate = re.sub(r"^\s*assistant\s*", "", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r"\s+", " ", candidate).strip()
    if candidate.startswith("[") or candidate.startswith("{"):
        return ""
    return candidate


def _decode_vibevoice_output(processor: Any, generated_ids: Any, duration: float) -> list[dict[str, Any]]:
    decoded_candidates: list[str] = []
    parsed_payloads: list[Any] = []
    for candidate in [
        lambda: processor.decode(generated_ids, return_format="parsed"),
        lambda: processor.decode(generated_ids, return_format="transcription_only"),
        lambda: processor.decode(generated_ids, return_format="raw"),
        lambda: processor.decode(generated_ids[0], return_format="parsed"),
        lambda: processor.decode(generated_ids[0], return_format="transcription_only"),
        lambda: processor.decode(generated_ids[0], return_format="raw"),
        lambda: processor.batch_decode(generated_ids, skip_special_tokens=True)[0],
    ]:
        try:
            value = candidate()
        except Exception:
            continue

        if isinstance(value, list) and value and isinstance(value[0], dict):
            parsed_payloads.append(value)
            continue
        if isinstance(value, list) and value and isinstance(value[0], list):
            parsed_payloads.extend(item for item in value if isinstance(item, list))
            continue
        if isinstance(value, (list, tuple)):
            decoded_candidates.extend(str(item or "").strip() for item in value if str(item or "").strip())
        else:
            text = str(value or "").strip()
            if text:
                decoded_candidates.append(text)

    for payload in parsed_payloads:
        normalized = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            segment = _normalize_segment(item)
            if segment is not None:
                normalized.append(segment)
        if normalized:
            return normalized

    for candidate in decoded_candidates:
        parsed = _segments_from_json_payload(candidate)
        if parsed is not None:
            return parsed
        extracted = _segments_from_content_fields(candidate, duration)
        if extracted is not None:
            return extracted

    raw_text = next((item for item in decoded_candidates if item), "")
    cleaned_text = _clean_vibevoice_fallback_text(raw_text)
    if not cleaned_text:
        return []
    return [{
        "start": 0.0,
        "end": round(float(duration or 0.0), 3),
        "text": cleaned_text,
    }]


def _build_inputs(processor: Any, audio: Any, sample_rate: int) -> dict[str, Any]:
    if hasattr(processor, "apply_transcription_request"):
        request = processor.apply_transcription_request(
            audio=audio,
            sampling_rate=sample_rate,
            return_tensors="pt",
        )
    else:
        request = processor(
            audio=audio,
            sampling_rate=sample_rate,
            return_tensors="pt",
        )
    return dict(request)


def _resolve_model_load_kwargs(service_key: str, torch_device: str) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "trust_remote_code": True,
        "low_cpu_mem_usage": True,
        "torch_dtype": "auto",
    }

    if torch_device == "cuda":
        if service_key == "vibevoice-asr":
            offload_dir = os.path.join(_OFFLOAD_ROOT, service_key)
            os.makedirs(offload_dir, exist_ok=True)
            gpu_total_bytes = torch.cuda.get_device_properties(0).total_memory
            gpu_budget_gib = max(4, int(gpu_total_bytes // (1024 ** 3)) - 2)
            kwargs.update(
                {
                    "device_map": "balanced_low_0",
                    "max_memory": {0: f"{gpu_budget_gib}GiB", "cpu": "48GiB"},
                    "offload_state_dict": True,
                    "offload_folder": offload_dir,
                }
            )
        else:
            kwargs["device_map"] = "cuda:0"
    else:
        kwargs["device_map"] = "cpu"

    return kwargs


def _run_inference(
    *,
    service: str,
    audio_path: str,
    model_dir: str,
    device: str,
    max_new_tokens: int,
) -> dict[str, Any]:
    service_key = str(service or "").strip().lower()
    if service_key != "vibevoice-asr":
        raise RuntimeError(f"Unsupported Transformers 5.x ASR service: {service}")

    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")
    if not os.path.isdir(model_dir):
        raise FileNotFoundError(f"Model directory not found: {model_dir}")

    transformers = _import_transformers5_module()
    torch_device = _select_device(device)
    processor_class = getattr(transformers, "VibeVoiceAsrProcessor")
    processor = processor_class.from_pretrained(model_dir, trust_remote_code=True)

    model_class = getattr(transformers, "VibeVoiceAsrForConditionalGeneration")
    model = model_class.from_pretrained(
        model_dir,
        **_resolve_model_load_kwargs(service_key, torch_device),
    )
    if getattr(model, "hf_device_map", None) is None:
        model.to(torch_device)
    model.eval()
    model_dtype = getattr(model, "dtype", torch.float16 if torch_device == "cuda" else torch.float32)

    expected_sample_rate = 24000
    audio, sample_rate = _load_audio(audio_path, expected_sample_rate)
    duration = len(audio) / float(sample_rate or 1)
    inputs = _build_inputs(processor, audio, sample_rate)
    inputs = {
        key: (
            value.to(device=torch_device, dtype=model_dtype)
            if hasattr(value, "to") and torch.is_tensor(value) and torch.is_floating_point(value)
            else value.to(torch_device)
            if hasattr(value, "to") and torch.is_tensor(value)
            else value
        )
        for key, value in inputs.items()
    }

    with torch.inference_mode():
        output_ids = model.generate(**inputs, max_new_tokens=max(1, int(max_new_tokens or 256)))

    generated_ids = _extract_generated_continuation(output_ids, inputs)

    segments = _decode_vibevoice_output(processor, generated_ids, duration)
    for segment in segments:
        segment.setdefault("provider", "vibevoice-asr")

    return {
        "ok": True,
        "service": service_key,
        "device": torch_device,
        "duration": round(float(duration), 3),
        "segments": segments,
    }


def _run_status() -> dict[str, Any]:
    if not os.path.isdir(OVERLAY_DIR):
        return {
            "ok": False,
            "detail": f"Transformers 5.x overlay runtime directory is missing: {OVERLAY_DIR}",
        }
    if not os.path.isdir(RUNTIME_SITE_PACKAGES):
        return {
            "ok": False,
            "detail": f"Base runtime site-packages directory is missing: {RUNTIME_SITE_PACKAGES}",
        }

    try:
        transformers = _import_transformers5_module()
    except Exception as error:
        return {
            "ok": False,
            "detail": f"Failed to import transformers from overlay runtime: {error}",
        }

    version = str(getattr(transformers, "__version__", "unknown"))
    if not version.startswith("5."):
        return {
            "ok": False,
            "detail": (
                "Transformers 5.x overlay runtime did not take effect. "
                f"Imported version: {version}"
            ),
        }

    missing_symbols = [
        name
        for name in ["VibeVoiceAsrForConditionalGeneration"]
        if not hasattr(transformers, name)
    ]
    if missing_symbols:
        return {
            "ok": False,
            "detail": (
                "Transformers 5.x overlay is present but missing required ASR classes: "
                + ", ".join(missing_symbols)
            ),
        }

    return {
        "ok": True,
        "detail": f"Transformers overlay ready ({version}) at {OVERLAY_DIR}",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["status", "infer"], required=True)
    parser.add_argument("--service")
    parser.add_argument("--audio_path")
    parser.add_argument("--model_dir")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--language")
    parser.add_argument("--max_new_tokens", type=int, default=256)
    args = parser.parse_args()

    try:
        if args.mode == "status":
            payload = _run_status()
        else:
            payload = _run_inference(
                service=str(args.service or ""),
                audio_path=str(args.audio_path or ""),
                model_dir=str(args.model_dir or ""),
                device=str(args.device or "auto"),
                max_new_tokens=int(args.max_new_tokens or 256),
            )
    except Exception as error:
        payload = {
            "ok": False,
            "detail": str(error),
        }

    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
