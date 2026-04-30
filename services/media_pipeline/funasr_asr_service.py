from __future__ import annotations

import logging
import os
import shutil
import unicodedata
from typing import Any

from app_logging import get_logger, redirect_print
from model_profiles import get_asr_profile, resolve_existing_path
from subtitle_postprocess import clean_segment_text, finalize_subtitle_segments, normalize_output_segments

logger = get_logger("asr.funasr")
print = redirect_print(logger, default_level=logging.DEBUG)

_HALLUCINATION_KEYWORDS = (
    "请不吝点赞 订阅 转发",
    "打赏支持明镜",
)


def _should_insert_space_between(left: str, right: str) -> bool:
    if not left or not right:
        return False
    return left[-1:].isalnum() and right[:1].isalnum()


def _join_segment_texts(segments: list[dict[str, Any]]) -> str:
    pieces: list[str] = []
    previous = ""
    for segment in segments or []:
        current = clean_segment_text(segment.get("text", ""))
        if not current:
            continue
        if pieces and _should_insert_space_between(previous, current):
            pieces.append(" ")
        pieces.append(current)
        previous = current
    return clean_segment_text("".join(pieces))


def _infer_alignment_language(language: str | None, transcript: str) -> str | None:
    normalized = _normalize_language(language)
    if normalized:
        return normalized

    text = str(transcript or "").strip()
    if not text:
        return None

    latin_letters = sum(1 for char in text if ("A" <= char <= "Z") or ("a" <= char <= "z"))
    cjk_letters = sum(1 for char in text if "\u4e00" <= char <= "\u9fff")
    kana_letters = sum(1 for char in text if ("\u3040" <= char <= "\u30ff"))
    hangul_letters = sum(1 for char in text if ("\uac00" <= char <= "\ud7af"))
    letter_total = sum(1 for char in text if unicodedata.category(char).startswith("L"))

    if letter_total <= 0:
        return None
    if hangul_letters / letter_total >= 0.2:
        return "ko"
    if kana_letters / letter_total >= 0.2:
        return "ja"
    if cjk_letters / letter_total >= 0.2:
        return "zh"
    if latin_letters / letter_total >= 0.5:
        return "en"
    return None


def _realign_funasr_segments(
    audio_path: str,
    segments: list[dict[str, Any]],
    *,
    language: str | None,
    device: str,
) -> list[dict[str, Any]]:
    transcript = _join_segment_texts(segments)
    if not transcript:
        return normalize_output_segments(segments, hallucination_keywords=_HALLUCINATION_KEYWORDS)

    alignment_language = _infer_alignment_language(language, transcript)

    try:
        from qwen_forced_aligner_service import align_transcript_to_segments

        aligned_segments = align_transcript_to_segments(
            audio_path=audio_path,
            transcript=transcript,
            language=alignment_language,
            device=device,
        )
    except Exception as error:
        print(f"[FunASR] Forced alignment skipped: {error}")
        return normalize_output_segments(segments, hallucination_keywords=_HALLUCINATION_KEYWORDS)

    if not aligned_segments:
        return normalize_output_segments(segments, hallucination_keywords=_HALLUCINATION_KEYWORDS)

    for segment in aligned_segments:
        segment.setdefault("provider", "funasr")
    print(f"[FunASR] Forced alignment complete. Rebuilt {len(aligned_segments)} segments.")
    return normalize_output_segments(aligned_segments, hallucination_keywords=_HALLUCINATION_KEYWORDS)


def _ensure_funasr_runtime() -> None:
    from dependency_manager import ensure_package_installed

    if not ensure_package_installed("funasr", "funasr"):
        raise RuntimeError("FunASR Python runtime is not available. Please install funasr first.")


def _resolve_profile_assets(model_profile: str = "standard") -> dict[str, Any]:
    profile_key, profile = get_asr_profile("funasr", model_profile)
    model_dir = resolve_existing_path(profile.get("candidates") or [])
    vad_dir = resolve_existing_path(profile.get("vad_candidates") or [])
    punc_dir = resolve_existing_path(profile.get("punc_candidates") or [])
    return {
        "profile_key": profile_key,
        "profile": profile,
        "model_dir": model_dir,
        "vad_dir": vad_dir,
        "punc_dir": punc_dir,
        "model_ref": model_dir or profile.get("modelscope_model_id") or profile.get("model_name"),
        "vad_ref": vad_dir or profile.get("modelscope_vad_id") or profile.get("vad_model_name"),
        "punc_ref": punc_dir or profile.get("modelscope_punc_id") or profile.get("punc_model_name"),
    }


def _pick_download_target(candidates: list[str]) -> str | None:
    for candidate in candidates or []:
        if candidate:
            return candidate
    return None


def _download_hf_snapshot_if_needed(
    target_dir: str | None,
    repo_id: str | None,
    *,
    label: str,
) -> str | None:
    if target_dir and os.path.isdir(target_dir):
        return target_dir
    if not target_dir or not repo_id:
        return target_dir

    parent_dir = os.path.dirname(target_dir)
    if parent_dir:
        os.makedirs(parent_dir, exist_ok=True)

    print(f"[FunASR] Downloading {label} from Hugging Face: {repo_id}")
    try:
        from huggingface_hub import snapshot_download

        resolved_dir = snapshot_download(
            repo_id=repo_id,
            local_dir=target_dir,
            local_dir_use_symlinks=False,
            resume_download=True,
        )
    except Exception as error:
        if os.path.isdir(target_dir):
            shutil.rmtree(target_dir, ignore_errors=True)
        raise RuntimeError(f"Failed to download {label} from Hugging Face ({repo_id}): {error}") from error

    return resolved_dir if os.path.isdir(resolved_dir) else target_dir


def _require_existing_dir_or_model_id(
    path_value: str | None,
    label: str,
    candidates: list[str],
    fallback_model_id: str | None = None,
) -> str:
    if path_value and os.path.isdir(path_value):
        return path_value
    if fallback_model_id:
        return fallback_model_id
    raise FileNotFoundError(f"{label} not found. Expected one of: {', '.join(candidates)}")


def _resolve_device(device: str | None) -> str:
    normalized = str(device or "auto").strip().lower()
    if normalized == "cpu":
        return "cpu"
    try:
        import torch

        if normalized == "cuda":
            return "cuda:0" if torch.cuda.is_available() else "cpu"
        return "cuda:0" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _normalize_language(language: str | None) -> str | None:
    if language is None:
        return None
    normalized = str(language).strip().lower()
    if normalized in {"", "auto"}:
        return None
    language_aliases = {
        "chinese": "zh",
        "zh": "zh",
        "zh-cn": "zh",
        "cantonese": "yue",
        "yue": "yue",
        "english": "en",
        "en": "en",
        "japanese": "ja",
        "ja": "ja",
        "korean": "ko",
        "ko": "ko",
        "kr": "ko",
    }
    if normalized in language_aliases:
        return language_aliases[normalized]
    return None


def _normalize_timestamp_value(value: Any) -> float:
    if value in (None, ""):
        return 0.0
    try:
        numeric = float(value)
    except Exception:
        return 0.0

    if isinstance(value, int):
        return numeric / 1000.0
    if isinstance(value, float) and numeric > 100:
        return numeric / 1000.0
    return numeric


def _build_sentence_segments_from_result(result_item: dict[str, Any]) -> list[dict[str, Any]]:
    sentence_info = result_item.get("sentence_info")
    if isinstance(sentence_info, list) and sentence_info:
        segments = []
        for item in sentence_info:
            if not isinstance(item, dict):
                continue
            text = clean_segment_text(str(item.get("text", "") or item.get("sentence", "") or ""))
            if not text:
                continue
            start = _normalize_timestamp_value(item.get("start", item.get("start_time")))
            end = _normalize_timestamp_value(item.get("end", item.get("end_time")))
            if end <= start:
                end = round(start + 0.05, 3)
            segments.append({
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text,
            })
        if segments:
            return segments

    timestamp = result_item.get("timestamp")
    text = clean_segment_text(str(result_item.get("text", "") or ""))
    if isinstance(timestamp, list) and text:
        flat_pairs = [pair for pair in timestamp if isinstance(pair, (list, tuple)) and len(pair) >= 2]
        if flat_pairs:
            start = _normalize_timestamp_value(flat_pairs[0][0])
            end = _normalize_timestamp_value(flat_pairs[-1][1])
            if end <= start:
                end = round(start + 0.05, 3)
            return [{
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text,
            }]

    if text:
        return [{
            "start": 0.0,
            "end": 0.05,
            "text": text,
        }]
    return []


def _should_apply_funasr_splitter(
    result_items: list[dict[str, Any]],
    sentence_segments: list[dict[str, Any]],
) -> bool:
    if len(sentence_segments) <= 1:
        return True

    for item in result_items:
        sentence_info = item.get("sentence_info")
        if isinstance(sentence_info, list) and sentence_info:
            return False
    return True


def _finalize_funasr_segments(
    result_items,
    sentence_segments,
    *,
    splitter_kwargs=None,
    optimize_enabled=True,
):
    return finalize_subtitle_segments(
        sentence_segments,
        splitter_kwargs=splitter_kwargs,
        apply_splitter=_should_apply_funasr_splitter(result_items, sentence_segments),
        optimize_enabled=optimize_enabled,
        hallucination_keywords=_HALLUCINATION_KEYWORDS,
    )


def get_funasr_runtime_status(model_profile: str = "standard") -> tuple[bool, str | None]:
    try:
        _ensure_funasr_runtime()
    except Exception as error:
        return False, str(error)

    assets = _resolve_profile_assets(model_profile)
    profile = assets["profile"]

    try:
        model_ref = _require_existing_dir_or_model_id(
            assets["model_dir"],
            "FunASR acoustic model",
            list(profile.get("candidates") or []),
            profile.get("modelscope_model_id") or profile.get("model_name"),
        )
        vad_ref = _require_existing_dir_or_model_id(
            assets["vad_dir"],
            "FunASR VAD model",
            list(profile.get("vad_candidates") or []),
            profile.get("modelscope_vad_id") or profile.get("vad_model_name"),
        )
    except Exception as error:
        return False, str(error)

    punc_ref = None
    if profile.get("punc_candidates") or profile.get("modelscope_punc_id") or profile.get("punc_model_name"):
        try:
            punc_ref = _require_existing_dir_or_model_id(
                assets["punc_dir"],
                "FunASR punctuation model",
                list(profile.get("punc_candidates") or []),
                profile.get("modelscope_punc_id") or profile.get("punc_model_name"),
            )
        except Exception as error:
            return False, str(error)

    required_roots = {
        "FunASR acoustic model": model_ref,
        "FunASR VAD model": vad_ref,
    }
    if punc_ref:
        required_roots["FunASR punctuation model"] = punc_ref

    for label, path_value in required_roots.items():
        if not os.path.isdir(path_value):
            continue
        entries = [name for name in os.listdir(path_value) if not name.startswith(".")]
        if not entries:
            return False, f"{label} directory exists but is empty: {path_value}"

    if any(not os.path.isdir(path_value) for path_value in required_roots.values()):
        if profile.get("hf_model_id"):
            return True, "FunASR will download the configured multilingual assets from Hugging Face on first run."
        return True, "FunASR will download the configured multilingual assets on first run."
    return True, "FunASR acoustic/VAD/punctuation assets are ready."


def run_funasr_asr_inference(
    audio_path: str,
    model_profile: str = "standard",
    language: str | None = None,
    splitter_kwargs=None,
    device: str = "auto",
    batch_size_s: int = 300,
    merge_vad: bool = True,
    optimize_enabled: bool = True,
):
    runtime_ok, runtime_detail = get_funasr_runtime_status(model_profile)
    if not runtime_ok:
        raise RuntimeError(f"FunASR runtime is unavailable: {runtime_detail or 'unknown reason'}")

    assets = _resolve_profile_assets(model_profile)
    profile = assets["profile"]
    model_ref = assets["model_ref"]
    vad_ref = assets["vad_ref"]
    punc_ref = assets["punc_ref"]

    if not assets["model_dir"] and profile.get("hf_model_id"):
        model_ref = _download_hf_snapshot_if_needed(
            _pick_download_target(list(profile.get("candidates") or [])),
            profile.get("hf_model_id"),
            label="FunASR acoustic model",
        )
    if not model_ref:
        raise RuntimeError("FunASR acoustic model is unavailable after download resolution.")

    from funasr import AutoModel

    resolved_device = _resolve_device(device)
    normalized_language = _normalize_language(language)
    print(f"[FunASR] Loading model from: {model_ref}")
    print(f"[FunASR] VAD model: {vad_ref}")
    if punc_ref:
        print(f"[FunASR] Punctuation model: {punc_ref}")
    print(f"[FunASR] Device: {resolved_device}")

    auto_model_kwargs: dict[str, Any] = {
        "model": model_ref,
        "device": resolved_device,
    }
    if vad_ref:
        auto_model_kwargs["vad_model"] = vad_ref
    if punc_ref:
        auto_model_kwargs["punc_model"] = punc_ref
    if profile.get("trust_remote_code"):
        auto_model_kwargs["trust_remote_code"] = True

    model = AutoModel(**auto_model_kwargs)

    try:
        generate_kwargs: dict[str, Any] = {
            "input": audio_path,
            "batch_size_s": max(1, int(batch_size_s or 300)),
            "merge_vad": bool(merge_vad),
        }
        if normalized_language:
            generate_kwargs["language"] = normalized_language
        if profile.get("use_itn"):
            generate_kwargs["use_itn"] = True

        results = model.generate(**generate_kwargs)
        if isinstance(results, dict):
            result_list = [results]
        elif isinstance(results, list):
            result_list = [item for item in results if isinstance(item, dict)]
        else:
            result_list = []

        sentence_segments: list[dict[str, Any]] = []
        for item in result_list:
            sentence_segments.extend(_build_sentence_segments_from_result(item))

        sentence_segments = _finalize_funasr_segments(
            result_list,
            sentence_segments,
            splitter_kwargs=splitter_kwargs,
            optimize_enabled=optimize_enabled,
        )
        sentence_segments = _realign_funasr_segments(
            audio_path,
            sentence_segments,
            language=language,
            device=resolved_device,
        )
        print(f"[FunASR] Inference complete. Found {len(sentence_segments)} segments.")
        return sentence_segments
    finally:
        try:
            del model
        except Exception:
            pass
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
