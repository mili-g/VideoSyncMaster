import logging
import os
from functools import lru_cache

import torch

from app_logging import get_logger, redirect_print
from bootstrap.runtime_env import setup_gpu_paths
from dependency_manager import ensure_package_installed, ensure_transformers_version
from model_profiles import PROJECT_ROOT, PROJECT_ROOT_PROD, resolve_existing_path
from subtitle_postprocess import clean_segment_text, normalize_output_segments


logger = get_logger("asr.qwen_forced_aligner")
print = redirect_print(logger, default_level=logging.DEBUG)
setup_gpu_paths(logger)


_SUPPORTED_LANGUAGE_HINTS = {
    None: "Chinese",
    "": "Chinese",
    "auto": "Chinese",
    "zh": "Chinese",
    "chinese": "Chinese",
    "en": "English",
    "english": "English",
    "yue": "Cantonese",
    "cantonese": "Cantonese",
    "ja": "Japanese",
    "japanese": "Japanese",
    "ko": "Korean",
    "korean": "Korean",
    "fr": "French",
    "french": "French",
    "de": "German",
    "german": "German",
    "es": "Spanish",
    "spanish": "Spanish",
    "pt": "Portuguese",
    "portuguese": "Portuguese",
    "ru": "Russian",
    "russian": "Russian",
    "it": "Italian",
    "italian": "Italian",
}

_HALLUCINATION_KEYWORDS = (
    "请不吝点赞 订阅 转发",
    "打赏支持明镜",
)


def _aligner_candidates():
    return [
        os.path.join(PROJECT_ROOT, "models", "Qwen3-ForcedAligner-0.6B"),
        os.path.join(PROJECT_ROOT_PROD, "models", "Qwen3-ForcedAligner-0.6B"),
    ]


def _resolve_aligner_dir(model_name: str | None = None) -> str:
    if model_name and os.path.isdir(model_name):
        return model_name
    if model_name:
        direct_candidate = os.path.join(PROJECT_ROOT, "models", model_name)
        if os.path.isdir(direct_candidate):
            return direct_candidate
    model_dir = resolve_existing_path(_aligner_candidates())
    if not model_dir:
        raise FileNotFoundError(
            "Qwen3 Forced Aligner model directory not found. Expected one of: " + ", ".join(_aligner_candidates())
        )
    return model_dir


def _normalize_language_hint(language: str | None) -> str:
    normalized = str(language or "").strip().lower()
    return _SUPPORTED_LANGUAGE_HINTS.get(normalized, "Chinese")


def get_qwen_forced_aligner_runtime_status(model_name: str = "Qwen3-ForcedAligner-0.6B") -> tuple[bool, str | None]:
    try:
        model_dir = _resolve_aligner_dir(model_name)
    except Exception as error:
        return False, str(error)

    required_files = [
        "config.json",
        "model.safetensors",
        "preprocessor_config.json",
        "tokenizer_config.json",
        "vocab.json",
        "merges.txt",
    ]
    missing = [file_name for file_name in required_files if not os.path.exists(os.path.join(model_dir, file_name))]
    if missing:
        return False, "Qwen3 Forced Aligner model directory is incomplete: missing " + ", ".join(missing)

    try:
        ensure_transformers_version("4.57.6")
        ensure_package_installed("qwen-asr", "qwen-asr==0.0.6")
    except Exception as error:
        return False, f"Qwen3 Forced Aligner runtime dependency is unavailable: {error}"

    return True, "Qwen3 Forced Aligner runtime is ready."


@lru_cache(maxsize=2)
def _load_aligner(model_dir: str, device_key: str):
    ensure_transformers_version("4.57.6")
    ensure_package_installed("qwen-asr", "qwen-asr==0.0.6")

    from qwen_asr import Qwen3ForcedAligner

    if device_key == "cuda":
        kwargs = {
            "dtype": torch.bfloat16,
            "device_map": "cuda:0",
        }
    else:
        kwargs = {
            "dtype": torch.float32,
            "device_map": "cpu",
        }

    print(f"[QwenForcedAligner] Loading aligner from {model_dir} on {device_key}")
    return Qwen3ForcedAligner.from_pretrained(model_dir, **kwargs)


def _resolve_device(device: str = "auto") -> str:
    normalized = str(device or "auto").strip().lower()
    if normalized in {"cuda", "gpu"}:
        return "cuda"
    if normalized == "cpu":
        return "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"


def _group_aligned_items(items, gap_threshold: float = 0.72, max_chars: int = 36, max_duration: float = 7.5):
    if not items:
        return []

    terminal_punctuation = {"。", "！", "？", "!", "?", ";", "；"}
    grouped = []
    bucket = []

    def should_insert_space_between(left: str, right: str) -> bool:
        if not left or not right:
            return False
        return left[-1:].isalnum() and right[:1].isalnum()

    def join_bucket_text(parts) -> str:
        pieces = []
        previous = ""
        for part in parts:
            current = clean_segment_text(part)
            if not current:
                continue
            if pieces and should_insert_space_between(previous, current):
                pieces.append(" ")
            pieces.append(current)
            previous = current
        return clean_segment_text("".join(pieces))

    def flush():
        nonlocal bucket
        if not bucket:
            return
        text = join_bucket_text([item["text"] for item in bucket])
        if not text:
            bucket = []
            return
        grouped.append(
            {
                "start": round(float(bucket[0]["start"]), 3),
                "end": round(float(bucket[-1]["end"]), 3),
                "text": text,
            }
        )
        bucket = []

    for index, item in enumerate(items):
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        if bucket:
            gap = float(item["start"]) - float(bucket[-1]["end"])
            duration = float(bucket[-1]["end"]) - float(bucket[0]["start"])
            current_length = len("".join(seg["text"] for seg in bucket))
            if gap > gap_threshold or duration >= max_duration or current_length >= max_chars:
                flush()

        bucket.append(item)
        next_gap = None
        if index + 1 < len(items):
            next_gap = float(items[index + 1]["start"]) - float(item["end"])
        if text[-1:] in terminal_punctuation or (next_gap is not None and next_gap > gap_threshold):
            flush()

    flush()
    return normalize_output_segments(grouped, hallucination_keywords=_HALLUCINATION_KEYWORDS)


def align_transcript_to_segments(
    audio_path: str,
    transcript: str,
    language: str | None = None,
    model_name: str = "Qwen3-ForcedAligner-0.6B",
    device: str = "auto",
):
    runtime_ok, runtime_detail = get_qwen_forced_aligner_runtime_status(model_name)
    if not runtime_ok:
        raise RuntimeError(runtime_detail or "Qwen3 Forced Aligner runtime is unavailable.")

    transcript_text = clean_segment_text(str(transcript or ""))
    if not transcript_text:
        return []

    model_dir = _resolve_aligner_dir(model_name)
    resolved_device = _resolve_device(device)
    aligner = _load_aligner(model_dir, resolved_device)
    language_hint = _normalize_language_hint(language)

    print(
        f"[QwenForcedAligner] Aligning transcript with device={resolved_device}, "
        f"language={language_hint}, audio={audio_path}"
    )
    result = aligner.align(audio=audio_path, text=transcript_text, language=language_hint)[0]
    aligned_items = [
        {
            "text": clean_segment_text(item.text),
            "start": round(float(item.start_time), 3),
            "end": round(float(item.end_time), 3),
        }
        for item in result
        if clean_segment_text(item.text)
    ]
    return _group_aligned_items(aligned_items)
