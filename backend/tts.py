import sys
import os
import re
import torch
import soundfile as sf
import traceback
import json
import subprocess
import atexit
import threading
import time
import math
import logging
import torchaudio
from torch.nn.utils.rnn import pad_sequence
from app_logging import get_logger, log_business, log_debug, log_error, redirect_print
from audio_validation import validate_generated_audio, validate_generated_audio_array
from event_protocol import emit_issue, emit_partial_result, emit_progress, emit_stage
from ffmpeg_utils import ensure_portable_ffmpeg_in_path, resolve_ffmpeg_executable
from gpu_runtime import choose_adaptive_batch_size, format_gpu_snapshot

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.append(BACKEND_DIR)

logger = get_logger("tts.indextts")
print = redirect_print(logger, default_level=logging.DEBUG)

ensure_portable_ffmpeg_in_path()

try:
    from dependency_manager import ensure_transformers_version
    ensure_transformers_version("4.52.1")
except ImportError:
    print("[IndexTTS] Dependency manager not found, skipping version check.")

try:
    from indextts.infer_v2 import IndexTTS2
except ImportError as e:
    print(f"Failed to import IndexTTS2: {e}")
    IndexTTS2 = None

# Default Checkpoint Paths
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
# 1. Dev: ../models/index-tts
PATH_DEV = os.path.join(BACKEND_DIR, "..", "models", "index-tts")
# 2. Prod: ../../models/index-tts
PATH_PROD = os.path.join(BACKEND_DIR, "..", "..", "models", "index-tts")

if os.path.exists(PATH_PROD):
    DEFAULT_MODEL_DIR = PATH_PROD
else:
    DEFAULT_MODEL_DIR = PATH_DEV
    
DEFAULT_CONFIG_PATH = os.path.join(DEFAULT_MODEL_DIR, "config.yaml")
INDEXTTS_ALLOWED_INFER_KWARGS = {
    "do_sample",
    "top_k",
    "top_p",
    "temperature",
    "repetition_penalty",
    "length_penalty",
    "num_beams",
    "max_mel_tokens",
    "max_text_tokens_per_segment",
    "inference_cfg_rate"
}
INDEXTTS_ENABLE_TRUE_BATCH = False
INDEXTTS_BATCH_RUNTIME_ALLOWED_KWARGS = {
    "do_sample",
    "top_k",
    "top_p",
    "temperature",
    "length_penalty",
    "num_beams",
    "repetition_penalty",
    "max_mel_tokens",
    "max_text_tokens_per_segment",
    "inference_cfg_rate",
    "diffusion_steps",
    "batch_size"
}

_INDEXTTS_INSTANCE = None
_INDEXTTS_INSTANCE_KEY = None
_INDEXTTS_INSTANCE_LOCK = threading.Lock()


def _read_indextts_force_fp32_flag():
    return os.getenv("INDEXTTS_FORCE_FP32", "").strip() == "1"


def _is_fatal_cuda_runtime_error(error):
    message = str(error or "").lower()
    return (
        "device-side assert triggered" in message
        or ("cuda error" in message and "device-side assert" in message)
        or "cuda kernel errors might be asynchronously reported" in message
    )


def _handle_fatal_indextts_cuda_error(error, context):
    if not _is_fatal_cuda_runtime_error(error):
        return

    print(f"[IndexTTS] Fatal CUDA runtime error during {context}. Dropping loaded instance before next retry.")
    try:
        _cleanup_indextts_instance()
    except Exception as cleanup_error:
        print(f"[IndexTTS] Cleanup after fatal CUDA error failed: {cleanup_error}")


def _build_indextts_kwargs(text, kwargs):
    valid_kwargs = {
        key: value for key, value in (kwargs or {}).items()
        if key in INDEXTTS_ALLOWED_INFER_KWARGS
    }

    if 'do_sample' not in valid_kwargs:
        valid_kwargs['do_sample'] = True
    if 'top_k' not in valid_kwargs:
        valid_kwargs['top_k'] = 50
    if 'top_p' not in valid_kwargs:
        valid_kwargs['top_p'] = 1.0
    if 'temperature' not in valid_kwargs:
        valid_kwargs['temperature'] = 0.9

    text_len = len((text or '').strip())
    if text_len <= 12:
        valid_kwargs['top_k'] = min(int(valid_kwargs.get('top_k', 50)), 20)
        valid_kwargs['top_p'] = min(float(valid_kwargs.get('top_p', 1.0)), 0.85)
        valid_kwargs['temperature'] = min(float(valid_kwargs.get('temperature', 0.9)), 0.65)
        valid_kwargs['repetition_penalty'] = max(float(valid_kwargs.get('repetition_penalty', 1.0)), 1.12)
    elif text_len <= 32:
        valid_kwargs['top_k'] = min(int(valid_kwargs.get('top_k', 50)), 35)
        valid_kwargs['top_p'] = min(float(valid_kwargs.get('top_p', 1.0)), 0.92)
        valid_kwargs['temperature'] = min(float(valid_kwargs.get('temperature', 0.9)), 0.78)
        valid_kwargs['repetition_penalty'] = max(float(valid_kwargs.get('repetition_penalty', 1.0)), 1.08)

    return valid_kwargs


def _resolve_requested_indextts_max_mel_tokens(kwargs):
    requested = (kwargs or {}).get("max_mel_tokens")
    if requested in (None, "", 0):
        requested = (kwargs or {}).get("max_new_tokens")
    if requested in (None, "", 0):
        requested = 1500
    try:
        return max(int(requested), 240)
    except Exception:
        return 1500


def _resolve_requested_indextts_segment_limit(kwargs):
    requested = (kwargs or {}).get("max_text_tokens_per_segment")
    if requested in (None, "", 0):
        requested = 80
    try:
        return max(int(requested), 24)
    except Exception:
        return 80


def _compute_indextts_segment_limit(text, requested_limit, *, safe_mode=False):
    text_len = len((text or "").strip())
    recommended_limit = 80

    if text_len <= 16:
        recommended_limit = 48 if safe_mode else 56
    elif text_len <= 32:
        recommended_limit = 56 if safe_mode else 64
    elif text_len <= 64:
        recommended_limit = 64 if safe_mode else 72

    return max(24, min(int(requested_limit or 80), recommended_limit))


def _compute_indextts_max_mel_tokens(text, requested_cap, *, target_duration=None, safe_mode=False):
    cap = max(int(requested_cap or 1500), 240)
    text_len = len((text or "").strip())

    if target_duration and float(target_duration) > 0:
        buffered_duration = float(target_duration) * (1.55 if not safe_mode else 1.25) + (0.45 if not safe_mode else 0.20)
        return max(240, _estimate_max_generate_tokens_for_duration(buffered_duration, cap))

    if text_len <= 8:
        recommended = 320 if safe_mode else 420
    elif text_len <= 16:
        recommended = 360 if safe_mode else 480
    elif text_len <= 32:
        recommended = 440 if safe_mode else 600
    elif text_len <= 56:
        recommended = 560 if safe_mode else 760
    elif text_len <= 96:
        recommended = 760 if safe_mode else 980
    else:
        recommended = 920 if safe_mode else 1200

    return max(240, min(cap, recommended))


def _build_indextts_infer_kwargs(text, kwargs, *, target_duration=None, safe_mode=False):
    base_kwargs = _build_indextts_kwargs(text, kwargs)
    requested_cap = _resolve_requested_indextts_max_mel_tokens(kwargs)
    requested_segment_limit = _resolve_requested_indextts_segment_limit(kwargs)

    base_kwargs["max_mel_tokens"] = _compute_indextts_max_mel_tokens(
        text,
        requested_cap,
        target_duration=target_duration,
        safe_mode=safe_mode
    )
    base_kwargs["max_text_tokens_per_segment"] = _compute_indextts_segment_limit(
        text,
        requested_segment_limit,
        safe_mode=safe_mode
    )

    if safe_mode:
        base_kwargs["do_sample"] = True
        base_kwargs["top_k"] = min(int(base_kwargs.get("top_k", 50)), 16)
        base_kwargs["top_p"] = min(float(base_kwargs.get("top_p", 1.0)), 0.82)
        base_kwargs["temperature"] = min(float(base_kwargs.get("temperature", 0.9)), 0.62)
        base_kwargs["repetition_penalty"] = max(float(base_kwargs.get("repetition_penalty", 1.0)), 1.16)
        base_kwargs["num_beams"] = min(int(base_kwargs.get("num_beams", 1)), 1)
        base_kwargs["length_penalty"] = min(float(base_kwargs.get("length_penalty", 1.0)), 0.9)

    return base_kwargs


def _should_retry_indextts_with_safe_mode(error):
    message = str(error or "").lower()
    return (
        "suspiciously long" in message
        or "generated audio too long" in message
        or "hallucination" in message
    )


def _run_indextts_with_safe_retry(
    tts,
    *,
    ref_audio_path,
    text,
    normalized_text,
    output_path,
    kwargs,
    target_duration=None,
    verbose=False
):
    attempts = [("primary", False)]
    if len((text or "").strip()) <= 96:
        attempts.append(("safe_retry", True))

    last_error = None
    used_label = "primary"

    for attempt_index, (attempt_label, safe_mode) in enumerate(attempts, start=1):
        infer_kwargs = _build_indextts_infer_kwargs(
            normalized_text,
            kwargs,
            target_duration=target_duration,
            safe_mode=safe_mode
        )
        try:
            if attempt_index > 1:
                print(
                    f"[IndexTTS] Retrying short-text generation with safer settings "
                    f"(segment_limit={infer_kwargs.get('max_text_tokens_per_segment')}, "
                    f"max_mel_tokens={infer_kwargs.get('max_mel_tokens')})."
                )

            tts.infer(
                spk_audio_prompt=ref_audio_path,
                text=normalized_text,
                output_path=output_path,
                verbose=verbose,
                **infer_kwargs
            )
            duration = _validate_indextts_output(output_path, text)
            used_label = attempt_label
            return duration, used_label
        except Exception as error:
            last_error = error
            if attempt_index >= len(attempts) or not _should_retry_indextts_with_safe_mode(error):
                raise
            print(f"[IndexTTS] Detected unstable generation, switching to safe retry: {error}")

    raise last_error


def _sanitize_indextts_batch_runtime_kwargs(kwargs):
    return {
        key: value
        for key, value in (kwargs or {}).items()
        if key in INDEXTTS_BATCH_RUNTIME_ALLOWED_KWARGS
    }


def _should_use_indextts_true_batch(adaptive_batch_size):
    return INDEXTTS_ENABLE_TRUE_BATCH and int(adaptive_batch_size or 1) > 1


def _validate_indextts_duration(audio_path, text):
    info = sf.info(audio_path)
    dur = info.duration
    text_len = len((text or '').strip())

    if 29.8 < dur < 30.2 and text_len < 50:
        raise Exception(f"Generated audio is suspiciously long ({dur:.2f}s) for short text '{text[:20]}...'. Likely timeout/hallucination.")

    if dur > 60:
        raise Exception(f"Generated audio too long ({dur:.2f}s).")

    if text_len < 10 and dur > 15.0:
        raise Exception(f"Generated audio too long ({dur:.2f}s) for very short text '{text[:20]}...'.")

    if text_len < 24 and dur > 18.0:
        raise Exception(f"Generated audio too long ({dur:.2f}s) for short text '{text[:20]}...'.")

    return dur


def _validate_indextts_output(audio_path, text):
    is_valid, validation_info = validate_generated_audio(audio_path)
    if not is_valid:
        raise Exception(f"Generated audio rejected: {validation_info}")

    duration = None
    if isinstance(validation_info, dict):
        duration = float(validation_info.get("duration") or 0.0)

    if not duration:
        duration = _validate_indextts_duration(audio_path, text)
    else:
        text_len = len((text or '').strip())
        if 29.8 < duration < 30.2 and text_len < 50:
            raise Exception(f"Generated audio is suspiciously long ({duration:.2f}s) for short text '{text[:20]}...'. Likely timeout/hallucination.")
        if duration > 60:
            raise Exception(f"Generated audio too long ({duration:.2f}s).")
        if text_len < 10 and duration > 15.0:
            raise Exception(f"Generated audio too long ({duration:.2f}s) for very short text '{text[:20]}...'.")
        if text_len < 24 and duration > 18.0:
            raise Exception(f"Generated audio too long ({duration:.2f}s) for short text '{text[:20]}...'.")

    return duration


def _validate_indextts_array_output(audio_array, sample_rate, text):
    is_valid, validation_info = validate_generated_audio_array(audio_array, sample_rate)
    if not is_valid:
        raise Exception(f"Generated audio rejected: {validation_info}")

    duration = None
    if isinstance(validation_info, dict):
        duration = float(validation_info.get("duration") or 0.0)

    if not duration:
        duration = float(len(audio_array) / float(sample_rate or 1))

    text_len = len((text or '').strip())
    if 29.8 < duration < 30.2 and text_len < 50:
        raise Exception(f"Generated audio is suspiciously long ({duration:.2f}s) for short text '{text[:20]}...'. Likely timeout/hallucination.")
    if duration > 60:
        raise Exception(f"Generated audio too long ({duration:.2f}s).")
    if text_len < 10 and duration > 15.0:
        raise Exception(f"Generated audio too long ({duration:.2f}s) for very short text '{text[:20]}...'.")
    if text_len < 24 and duration > 18.0:
        raise Exception(f"Generated audio too long ({duration:.2f}s) for short text '{text[:20]}...'.")

    return duration


def _chunk_list(values, chunk_size):
    if chunk_size <= 0:
        chunk_size = 1
    for index in range(0, len(values), chunk_size):
        yield values[index:index + chunk_size]


def _estimate_target_frames(duration_sec):
    return max(int(max(float(duration_sec or 0.1), 0.1) * 86), 1)


def _estimate_max_generate_tokens_for_duration(duration_sec, requested_cap):
    safe_duration = max(float(duration_sec or 0.1), 0.1)
    cap = max(int(requested_cap or 1500), 1)

    # IndexTTS typically needs around 50 GPT tokens per second of output audio.
    # Keep a large safety margin so short segments can stop naturally without
    # clipping quality, while still avoiding the extremely loose global cap.
    estimated_tokens = (safe_duration * 50.0 * 2.8) + 96.0
    dynamic_cap = max(320, int(math.ceil(estimated_tokens)))
    return min(dynamic_cap, cap)


def _pad_last_dim_tensors(tensors, pad_value=0.0):
    max_length = max(tensor.shape[-1] for tensor in tensors)
    if len(tensors) == 1:
        return tensors[0]

    padded = []
    for tensor in tensors:
        if tensor.shape[-1] == max_length:
            padded.append(tensor)
            continue
        pad_amount = max_length - tensor.shape[-1]
        padded.append(torch.nn.functional.pad(tensor, (0, pad_amount), value=pad_value))
    return torch.cat(padded, dim=0)


def _extract_generated_code_lengths(tts, codes):
    code_lens = []
    max_code_len = 0
    for code in codes:
        if tts.stop_mel_token not in code:
            code_len = len(code)
        else:
            stop_positions = (code == tts.stop_mel_token).nonzero(as_tuple=False)
            code_len = stop_positions[0][0].item() if stop_positions.numel() > 0 else len(code)
        code_lens.append(code_len)
        max_code_len = max(max_code_len, code_len)

    trimmed_codes = codes[:, :max_code_len]
    code_lens_tensor = torch.LongTensor(code_lens).to(codes.device)
    return trimmed_codes, code_lens_tensor


def _ensure_indextts_batch_capacity(tts, batch_size, max_seq_length=8192):
    effective_batch = max(int(batch_size or 1), 1)
    effective_seq_length = max(int(max_seq_length or 1), 1)
    try:
        tts.s2mel.models['cfm'].estimator.setup_caches(
            max_batch_size=effective_batch,
            max_seq_length=max(8192, effective_seq_length)
        )
    except Exception as cache_error:
        print(f"[BatchTTS] Warning: failed to resize S2Mel caches for batch={effective_batch}: {cache_error}")


def _prepare_indextts_reference_features(tts, ref_audio_path, reference_cache, verbose=False):
    cached = reference_cache.get(ref_audio_path)
    if cached is not None:
        return cached

    audio, sr = tts._load_and_cut_audio(ref_audio_path, 15, verbose)
    audio_22k = torchaudio.transforms.Resample(sr, 22050)(audio)
    audio_16k = torchaudio.transforms.Resample(sr, 16000)(audio)

    inputs = tts.extract_features(audio_16k, sampling_rate=16000, return_tensors="pt")
    input_features = inputs["input_features"].to(tts.device)
    attention_mask = inputs["attention_mask"].to(tts.device)
    spk_cond_emb = tts.get_emb(input_features, attention_mask)

    _, semantic_ref = tts.semantic_codec.quantize(spk_cond_emb)
    ref_mel = tts.mel_fn(audio_22k.to(spk_cond_emb.device).float())
    ref_target_lengths = torch.LongTensor([ref_mel.size(2)]).to(ref_mel.device)
    feat = torchaudio.compliance.kaldi.fbank(
        audio_16k.to(ref_mel.device),
        num_mel_bins=80,
        dither=0,
        sample_frequency=16000
    )
    feat = feat - feat.mean(dim=0, keepdim=True)
    style = tts.campplus_model(feat.unsqueeze(0))

    prompt_condition = tts.s2mel.models['length_regulator'](
        semantic_ref,
        ylens=ref_target_lengths,
        n_quantizers=3,
        f0=None
    )[0]

    prepared = {
        "spk_cond_emb": spk_cond_emb,
        "emo_cond_emb": spk_cond_emb,
        "style": style,
        "prompt_condition": prompt_condition,
        "prompt_condition_len": int(prompt_condition.shape[1]),
        "ref_mel": ref_mel,
        "ref_mel_len": int(ref_mel.shape[-1]),
        "cond_len": int(spk_cond_emb.shape[1]),
        "emo_cond_len": int(spk_cond_emb.shape[1])
    }
    reference_cache[ref_audio_path] = prepared
    return prepared


_MIXED_LATIN_RE = re.compile(r"[A-Za-z]")
_CODE_STYLE_RE = re.compile(r"(</?[A-Za-z][^>]*>|[A-Za-z_]+\.[A-Za-z_]+|[A-Za-z_]+/[A-Za-z_]+|[A-Za-z_]+\([^\)]*\))")
_IDENTIFIER_DOT_RE = re.compile(r"(?<=[A-Za-z0-9_])\.(?=[A-Za-z0-9_])")
_IDENTIFIER_SLASH_RE = re.compile(r"(?<=[A-Za-z0-9_])/(?=[A-Za-z0-9_])")
_CAMEL_CASE_BOUNDARY_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def _normalize_identifier_fragment(fragment):
    value = str(fragment or "").strip()
    if not value:
        return ""

    value = _CAMEL_CASE_BOUNDARY_RE.sub(" ", value)
    value = value.replace("_", " ")
    value = value.replace("-", " ")
    value = re.sub(r"\s+", " ", value).strip()
    return value.lower()


def _normalize_indextts_text(text):
    original = str(text or "")
    normalized = original

    normalized = _IDENTIFIER_DOT_RE.sub(" dot ", normalized)
    normalized = _IDENTIFIER_SLASH_RE.sub(" slash ", normalized)
    normalized = re.sub(r"(?<=[A-Za-z0-9_])\\(?=[A-Za-z0-9_])", " slash ", normalized)
    normalized = re.sub(r"(?<=[A-Za-z0-9_])::(?=[A-Za-z0-9_])", " dot dot ", normalized)

    def replace_identifier(match):
        return _normalize_identifier_fragment(match.group(0))

    normalized = re.sub(r"[A-Za-z][A-Za-z0-9_\-]*", replace_identifier, normalized)
    normalized = normalized.replace("_", " ")
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized or original


def _classify_indextts_risk(task, token_count):
    text = str(task.get("text") or "").strip()
    duration = max(float(task.get("duration", 0.0) or 0.0), 0.0)
    ref_text = str(task.get("ref_text") or "").strip()

    has_latin = bool(_MIXED_LATIN_RE.search(text))
    has_code_style = bool(_CODE_STYLE_RE.search(text))
    has_symbol_noise = any(ch in text for ch in ("<", ">", "/", "_", "`", "=", "{", "}", "[", "]"))
    punctuation_count = sum(text.count(ch) for ch in ("，", "。", "、", ",", ".", ":", "：", ";", "；"))

    if has_code_style or has_symbol_noise:
        return True, "code_style"
    if has_latin and len(text) <= 40:
        return True, "mixed_latin"
    if duration < 1.25:
        return True, "very_short_duration"
    if len(text) <= 5:
        return True, "very_short_text"
    if token_count <= 6:
        return True, "very_short_tokens"
    if punctuation_count >= 4 and len(text) <= 24:
        return True, "dense_punctuation"
    if ref_text and len(ref_text) <= 3:
        return True, "very_short_ref_text"

    return False, "batchable"


def _build_indextts_batch_plan(tts, tasks, kwargs):
    max_text_tokens_per_segment = int(kwargs.get("max_text_tokens_per_segment", 120) or 120)
    stop_text_token = int(tts.gpt.stop_text_token)
    batchable = []
    sequential = []
    sequential_reason_counts = {}

    for task in tasks:
        text = task.get("text", "")
        normalized_text = _normalize_indextts_text(text)
        text_tokens_list = tts.tokenizer.tokenize(normalized_text)
        segments = tts.tokenizer.split_segments(text_tokens_list, max_text_tokens_per_segment)
        if len(segments) != 1:
            sequential.append(task)
            continue

        token_ids = tts.tokenizer.convert_tokens_to_ids(segments[0])
        if not token_ids:
            sequential.append(task)
            continue

        token_count = len(token_ids)
        is_high_risk, risk_reason = _classify_indextts_risk(task, token_count)
        if is_high_risk:
            sequential.append(task)
            sequential_reason_counts[risk_reason] = sequential_reason_counts.get(risk_reason, 0) + 1
            continue

        batchable.append({
            "task": task,
            "normalized_text": normalized_text,
            "token_count": token_count,
            "token_tensor": torch.tensor(token_ids, dtype=torch.int32),
            "text_padding_value": stop_text_token,
            "estimated_frames": _estimate_target_frames(task.get("duration", 0.1))
        })

    batchable.sort(key=lambda item: (item["token_count"], item["estimated_frames"], item["task"].get("duration", 0.0)))
    reason_parts = ", ".join(f"{key}={value}" for key, value in sorted(sequential_reason_counts.items()))
    print(
        f"[BatchPlan] total={len(tasks)} batchable={len(batchable)} sequential={len(sequential)}"
        + (f" reasons: {reason_parts}" if reason_parts else "")
    )
    return batchable, sequential


def _should_flush_dynamic_bucket(bucket, candidate, max_batch_size):
    if not bucket:
        return False
    if len(bucket) >= max_batch_size:
        return True

    token_counts = [entry["token_count"] for entry in bucket]
    frame_counts = [entry["estimated_frames"] for entry in bucket]
    current_max_tokens = max(token_counts)
    current_max_frames = max(frame_counts)
    next_max_tokens = max(current_max_tokens, candidate["token_count"])
    next_max_frames = max(current_max_frames, candidate["estimated_frames"])
    next_size = len(bucket) + 1

    padded_token_cost = next_max_tokens * next_size
    actual_token_cost = sum(token_counts) + candidate["token_count"]
    padded_frame_cost = next_max_frames * next_size
    actual_frame_cost = sum(frame_counts) + candidate["estimated_frames"]

    token_padding_ratio = padded_token_cost / max(actual_token_cost, 1)
    frame_padding_ratio = padded_frame_cost / max(actual_frame_cost, 1)
    token_span = next_max_tokens - min(token_counts + [candidate["token_count"]])
    frame_span = next_max_frames - min(frame_counts + [candidate["estimated_frames"]])
    duration_values = [float(entry["task"].get("duration", 0.0) or 0.0) for entry in bucket] + [float(candidate["task"].get("duration", 0.0) or 0.0)]
    max_duration = max(duration_values)
    min_duration = max(min(duration_values), 0.1)
    duration_ratio = max_duration / min_duration

    if next_size >= 2 and token_padding_ratio > 1.22:
        return True
    if next_size >= 2 and frame_padding_ratio > 1.25:
        return True
    if next_size >= 2 and token_span > 18:
        return True
    if next_size >= 2 and frame_span > 120:
        return True
    if next_size >= 2 and duration_ratio > 1.8:
        return True

    return False


def _build_dynamic_batch_buckets(batchable_tasks, max_batch_size):
    if not batchable_tasks:
        return []

    effective_batch_size = max(int(max_batch_size or 1), 1)
    buckets = []
    current_bucket = []

    for candidate in batchable_tasks:
        if _should_flush_dynamic_bucket(current_bucket, candidate, effective_batch_size):
            buckets.append(current_bucket)
            current_bucket = []
        current_bucket.append(candidate)

    if current_bucket:
        buckets.append(current_bucket)

    return buckets


def _run_indextts_true_batch(tts, batch_entries, kwargs, reference_cache):
    generation_kwargs = dict(kwargs or {})
    generation_kwargs.pop("batch_size", None)
    max_text_tokens_per_segment = generation_kwargs.pop("max_text_tokens_per_segment", 120)
    do_sample = generation_kwargs.pop("do_sample", True)
    top_p = generation_kwargs.pop("top_p", 0.8)
    top_k = generation_kwargs.pop("top_k", 5)
    temperature = generation_kwargs.pop("temperature", 0.7)
    length_penalty = generation_kwargs.pop("length_penalty", 0.0)
    num_beams = generation_kwargs.pop("num_beams", 3)
    repetition_penalty = generation_kwargs.pop("repetition_penalty", 1.0)
    max_mel_tokens = generation_kwargs.pop("max_mel_tokens", 1500)
    inference_cfg_rate = generation_kwargs.pop("inference_cfg_rate", 0.7)
    diffusion_steps = int(generation_kwargs.pop("diffusion_steps", 25) or 25)
    _ = max_text_tokens_per_segment

    batch_size = len(batch_entries)
    prepared_items = []
    for entry in batch_entries:
        prepared_ref = _prepare_indextts_reference_features(
            tts,
            entry["task"]["ref_audio_path"],
            reference_cache
        )
        prepared_items.append({
            **entry,
            "prepared_ref": prepared_ref
        })

    dynamic_max_generate_length = min(
        max_mel_tokens,
        max(
            _estimate_max_generate_tokens_for_duration(
                entry["task"].get("duration", 0.1),
                max_mel_tokens
            )
            for entry in prepared_items
        )
    )
    dynamic_max_generate_length = max(240, int(dynamic_max_generate_length * 0.92))
    temperature = min(float(temperature), 0.62)
    top_p = min(float(top_p), 0.82)
    top_k = min(int(top_k), 18)
    repetition_penalty = max(float(repetition_penalty), 1.12)

    _ensure_indextts_batch_capacity(tts, batch_size)

    text_inputs = pad_sequence(
        [entry["token_tensor"] for entry in prepared_items],
        batch_first=True,
        padding_value=prepared_items[0]["text_padding_value"]
    ).to(tts.device)
    text_lengths = torch.LongTensor([entry["token_count"] for entry in prepared_items]).to(tts.device)
    cond_lengths = torch.LongTensor([entry["prepared_ref"]["cond_len"] for entry in prepared_items]).to(tts.device)
    emo_cond_lengths = torch.LongTensor([entry["prepared_ref"]["emo_cond_len"] for entry in prepared_items]).to(tts.device)
    prompt_condition_lengths = torch.LongTensor([entry["prepared_ref"]["prompt_condition_len"] for entry in prepared_items]).to(tts.device)
    ref_mel_lengths = torch.LongTensor([entry["prepared_ref"]["ref_mel_len"] for entry in prepared_items]).to(tts.device)

    spk_cond_emb = pad_sequence(
        [entry["prepared_ref"]["spk_cond_emb"].squeeze(0) for entry in prepared_items],
        batch_first=True
    ).to(tts.device)
    emo_cond_emb = pad_sequence(
        [entry["prepared_ref"]["emo_cond_emb"].squeeze(0) for entry in prepared_items],
        batch_first=True
    ).to(tts.device)
    prompt_condition = pad_sequence(
        [entry["prepared_ref"]["prompt_condition"].squeeze(0) for entry in prepared_items],
        batch_first=True
    ).to(tts.device)
    ref_mel = _pad_last_dim_tensors(
        [entry["prepared_ref"]["ref_mel"] for entry in prepared_items]
    ).to(tts.device)
    style = torch.cat([entry["prepared_ref"]["style"] for entry in prepared_items], dim=0).to(tts.device)

    with torch.no_grad():
        with torch.amp.autocast(text_inputs.device.type, enabled=tts.dtype is not None, dtype=tts.dtype):
            emovec = tts.gpt.merge_emovec(
                spk_cond_emb,
                emo_cond_emb,
                cond_lengths,
                emo_cond_lengths,
                alpha=1.0
            )

            codes, speech_conditioning_latent = tts.gpt.inference_speech(
                spk_cond_emb,
                text_inputs,
                emo_cond_emb,
                cond_lengths=cond_lengths,
                emo_cond_lengths=emo_cond_lengths,
                emo_vec=emovec,
                do_sample=do_sample,
                top_p=top_p,
                top_k=top_k,
                temperature=temperature,
                num_return_sequences=1,
                length_penalty=length_penalty,
                num_beams=num_beams,
                repetition_penalty=repetition_penalty,
                max_generate_length=dynamic_max_generate_length,
                **generation_kwargs
            )

            codes, code_lens = _extract_generated_code_lengths(tts, codes)
            use_speed = torch.zeros(batch_size, device=spk_cond_emb.device).long()

            latent = tts.gpt(
                speech_conditioning_latent,
                text_inputs,
                text_lengths,
                codes,
                code_lens * tts.gpt.mel_length_compression,
                emo_cond_emb,
                cond_mel_lengths=cond_lengths,
                emo_cond_mel_lengths=emo_cond_lengths,
                emo_vec=emovec,
                use_speed=use_speed
            )

        latent = tts.s2mel.models['gpt_layer'](latent)
        semantic_infer = tts.semantic_codec.quantizer.vq2emb(codes.unsqueeze(1)).transpose(1, 2)
        semantic_infer = semantic_infer + latent
        target_lengths = (code_lens.float() * 1.72).long().clamp_min(1)
        cond = tts.s2mel.models['length_regulator'](
            semantic_infer,
            ylens=target_lengths,
            n_quantizers=3,
            f0=None
        )[0]
        cat_condition = torch.cat([prompt_condition, cond], dim=1)
        cat_condition_lengths = prompt_condition_lengths + target_lengths
        vc_target = tts.s2mel.models['cfm'].inference(
            cat_condition,
            cat_condition_lengths,
            ref_mel,
            style,
            None,
            diffusion_steps,
            inference_cfg_rate=inference_cfg_rate
        )

    results = []
    sampling_rate = 22050
    for batch_index, entry in enumerate(prepared_items):
        task = entry["task"]
        output_path = task["output_path"]
        start_frame = int(ref_mel_lengths[batch_index].item())
        end_frame = int(cat_condition_lengths[batch_index].item())
        mel_slice = vc_target[batch_index:batch_index + 1, :, start_frame:end_frame]

        if mel_slice.shape[-1] <= 0:
            raise RuntimeError(f"Empty mel slice generated for batch index {batch_index}")

        with torch.no_grad():
            wav = tts.bigvgan(mel_slice.float()).squeeze(1)
        wav = torch.clamp(32767 * wav, -32767.0, 32767.0).cpu()
        wav_int16 = wav.type(torch.int16)
        wav_np = wav_int16.squeeze(0).numpy()
        duration = _validate_indextts_array_output(wav_np, sampling_rate, task["text"])

        if os.path.isfile(output_path):
            os.remove(output_path)
        output_dir = os.path.dirname(output_path)
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
        torchaudio.save(output_path, wav_int16, sampling_rate)
        results.append({
            "index": task.get("index"),
            "success": True,
            "audio_path": output_path,
            "duration": duration
        })

    return results


def _build_indextts_instance_key(model_dir, config_path):
    return (
        os.path.abspath(model_dir or DEFAULT_MODEL_DIR),
        os.path.abspath(config_path or DEFAULT_CONFIG_PATH),
        not _read_indextts_force_fp32_flag(),
        False,
        False
    )


def _cleanup_indextts_instance():
    global _INDEXTTS_INSTANCE, _INDEXTTS_INSTANCE_KEY

    with _INDEXTTS_INSTANCE_LOCK:
        if _INDEXTTS_INSTANCE is not None:
            try:
                del _INDEXTTS_INSTANCE
            except Exception:
                pass
            _INDEXTTS_INSTANCE = None
            _INDEXTTS_INSTANCE_KEY = None

    if torch.cuda.is_available():
        try:
            torch.cuda.empty_cache()
            log_debug(logger, "IndexTTS VRAM cache cleared", event="vram_cleared", stage="cleanup")
        except Exception as cleanup_error:
            log_error(logger, "Failed to clear IndexTTS VRAM cache", event="vram_clear_failed", stage="cleanup", detail=str(cleanup_error))


def _get_indextts_instance(model_dir=None, config_path=None):
    global _INDEXTTS_INSTANCE, _INDEXTTS_INSTANCE_KEY

    if IndexTTS2 is None:
        return None

    resolved_model_dir = model_dir or DEFAULT_MODEL_DIR
    resolved_config_path = config_path or DEFAULT_CONFIG_PATH
    instance_key = _build_indextts_instance_key(resolved_model_dir, resolved_config_path)

    with _INDEXTTS_INSTANCE_LOCK:
        if _INDEXTTS_INSTANCE is not None and _INDEXTTS_INSTANCE_KEY == instance_key:
            log_debug(logger, "Reusing existing IndexTTS instance", event="instance_reused", stage="init", detail=resolved_model_dir)
            return _INDEXTTS_INSTANCE

        if _INDEXTTS_INSTANCE is not None and _INDEXTTS_INSTANCE_KEY != instance_key:
            log_business(logger, logging.INFO, "IndexTTS model path changed, releasing old instance", event="instance_replaced", stage="init", detail=resolved_model_dir)
            try:
                del _INDEXTTS_INSTANCE
            except Exception:
                pass
            _INDEXTTS_INSTANCE = None
            _INDEXTTS_INSTANCE_KEY = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        use_fp16 = not _read_indextts_force_fp32_flag()
        log_business(
            logger,
            logging.INFO,
            "Initializing IndexTTS instance",
            event="instance_init",
            stage="init",
            detail=f"model_dir={resolved_model_dir} use_fp16={use_fp16}"
        )
        tts_instance = None
        try:
            tts_instance = IndexTTS2(
                cfg_path=resolved_config_path,
                model_dir=resolved_model_dir,
                use_fp16=use_fp16,
                use_cuda_kernel=False,
                use_deepspeed=False
            )
            _INDEXTTS_INSTANCE = tts_instance
            _INDEXTTS_INSTANCE_KEY = instance_key
            return _INDEXTTS_INSTANCE
        except Exception as init_error:
            _INDEXTTS_INSTANCE = None
            _INDEXTTS_INSTANCE_KEY = None
            infer_module = sys.modules.get("indextts.infer_v2")
            init_stage = getattr(tts_instance, "init_stage", None) or getattr(infer_module, "LAST_INDEXTTS_INIT_STAGE", None)
            if init_stage:
                log_error(logger, "IndexTTS initialization failed", event="instance_init_failed", stage="init", detail=f"stage={init_stage}")
            _handle_fatal_indextts_cuda_error(init_error, "model_init")
            if _is_fatal_cuda_runtime_error(init_error):
                raise RuntimeError(
                    "IndexTTS CUDA context entered a fatal state during model initialization. "
                    f"stage={init_stage or 'unknown'}. "
                    "The backend worker must be restarted before retrying."
                ) from init_error
            raise


atexit.register(_cleanup_indextts_instance)

def trim_silence(audio_path, output_path=None):
    """
    Trim silence from the beginning and end of the audio file using FFmpeg.
    """
    if not output_path:
        output_path = audio_path
        
    temp_path = audio_path.replace('.wav', '_trimmed_temp.wav')
    
    try:

        filter_str = "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB,areverse"
        
        cmd = [
            resolve_ffmpeg_executable(), '-y', '-i', audio_path,
            '-af', filter_str,
            temp_path
        ]
        
        subprocess.run(
            cmd,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace'
        )
        
        if os.path.exists(temp_path) and os.path.getsize(temp_path) > 1000: # >1KB
            if os.path.exists(output_path) and output_path != audio_path:
                os.remove(output_path)
            # Move temp to output
            if output_path == audio_path:
                os.remove(audio_path)
                os.rename(temp_path, audio_path)
            else:
                os.rename(temp_path, output_path)
            return True
        else:
            log_business(logger, logging.WARNING, "Trim resulted in empty output; keeping original audio", event="trim_empty_result", stage="trim", detail=audio_path)
            if os.path.exists(temp_path): os.remove(temp_path)
            return False
            
    except subprocess.CalledProcessError as e:
        log_error(logger, "FFmpeg trim silence failed", event="trim_failed", stage="trim", detail=(e.stderr or '').strip() or str(e))
        if os.path.exists(temp_path): 
            try: os.remove(temp_path)
            except: pass
        return False
    except Exception as e:
        log_error(logger, "Unexpected trim silence failure", event="trim_failed", stage="trim", detail=str(e))
        if os.path.exists(temp_path): 
            try: os.remove(temp_path)
            except: pass
        return False


def run_tts(text, ref_audio_path, output_path, model_dir=None, config_path=None, language="English", **kwargs):
    if IndexTTS2 is None:
        log_error(logger, "IndexTTS2 runtime is unavailable", event="service_unavailable", stage="single_tts")
        return False
    
    if model_dir is None:
        model_dir = DEFAULT_MODEL_DIR
    if config_path is None:
        config_path = DEFAULT_CONFIG_PATH
        
    normalized_text = _normalize_indextts_text(text)
    if normalized_text != text:
        log_debug(logger, "Normalized TTS input text", event="text_normalized", stage="single_tts", detail=f"{text} -> {normalized_text}")
    

    
    started_at = time.perf_counter()
    try:
        tts = _get_indextts_instance(model_dir=model_dir, config_path=config_path)
        if tts is None:
            return False
        
        log_business(logger, logging.INFO, "Starting single TTS synthesis", event="single_tts_started", stage="single_tts", detail=f"ref={ref_audio_path}")
        
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        
        duration, retry_mode = _run_indextts_with_safe_retry(
            tts,
            ref_audio_path=ref_audio_path,
            text=text,
            normalized_text=normalized_text,
            output_path=output_path,
            kwargs=kwargs,
            target_duration=kwargs.get("target_duration"),
            verbose=True
        )
        elapsed_ms = (time.perf_counter() - started_at) * 1000.0
        rtf = (elapsed_ms / 1000.0) / max(float(duration or 0.001), 0.001)
        print(
            f"[TTSTiming] mode=single total={elapsed_ms:.0f}ms "
            f"audio={duration:.2f}s rtf={rtf:.3f} retry={retry_mode} path={output_path}"
        )
        
        log_business(logger, logging.INFO, "Single TTS synthesis completed", event="single_tts_completed", stage="single_tts", detail=output_path)
        return True
        
    except Exception as e:
        _handle_fatal_indextts_cuda_error(e, "single_tts")
        elapsed_ms = (time.perf_counter() - started_at) * 1000.0
        print(f"[TTSTiming] mode=single_failed total={elapsed_ms:.0f}ms path={output_path}")
        log_error(logger, "Single TTS synthesis failed", event="single_tts_failed", stage="single_tts", detail=str(e))
        import traceback
        traceback.print_exc()
        return False


def run_batch_tts(tasks, model_dir=None, config_path=None, language="English", **kwargs):
    """
    Run Batch Voice Cloning TTS.
    :param tasks: List of dicts {text, ref_audio_path, output_path}
    :param language: Default language for tasks if not specified in task item
    """
    if IndexTTS2 is None:
        log_error(logger, "IndexTTS2 runtime is unavailable", event="service_unavailable", stage="batch_tts")
        # Fix: Yield error for each task so main.py knows it failed explicitly
        for task in tasks:
            yield {"success": False, "error": "IndexTTS2 not available: " + str(sys.modules.get('indextts.infer_v2', 'Unknown Import Error'))}
        return

    if model_dir is None:
        model_dir = DEFAULT_MODEL_DIR
    if config_path is None:
        config_path = DEFAULT_CONFIG_PATH

    try:
        tts = _get_indextts_instance(model_dir=model_dir, config_path=config_path)
        if tts is None:
            raise RuntimeError("IndexTTS2 instance initialization failed")
        
        total = len(tasks)
        progress_completed_offset = max(int(kwargs.get("progress_completed_offset", 0) or 0), 0)
        progress_total_override = max(int(kwargs.get("progress_total_override", 0) or 0), 0)
        progress_total = max(progress_total_override, progress_completed_offset + total, total)
        requested_batch_size = max(int(kwargs.get('batch_size', 1) or 1), 1)
        adaptive_batch_size, adaptive_detail = choose_adaptive_batch_size(requested_batch_size, "indextts")
        if adaptive_detail:
            log_business(logger, logging.INFO, "Adaptive batch size selected", event="adaptive_batch_selected", stage="batch_tts", detail=format_gpu_snapshot(adaptive_detail))

        runtime_kwargs = _sanitize_indextts_batch_runtime_kwargs(kwargs)
        runtime_kwargs['batch_size'] = adaptive_batch_size
        reference_cache = {}
        emit_stage(
            "generate_batch_tts",
            "tts_generate",
            f"正在生成 {progress_total} 条 IndexTTS 配音",
            stage_label="正在生成配音"
        )
        batchable_tasks, sequential_tasks = _build_indextts_batch_plan(tts, tasks, runtime_kwargs)
        processed = 0

        def emit_task_result(result, *, item_position):
            nonlocal processed
            processed += 1
            emit_partial_result("generate_batch_tts", result)
            display_position = min(progress_completed_offset + processed, progress_total) if progress_total else processed
            emit_progress(
                "generate_batch_tts",
                "tts_generate",
                int(display_position / progress_total * 100) if progress_total else 100,
                f"第 {display_position}/{progress_total} 条已完成",
                stage_label="正在生成配音",
                item_index=display_position,
                item_total=progress_total
            )

        dynamic_buckets = _build_dynamic_batch_buckets(batchable_tasks, adaptive_batch_size)

        if dynamic_buckets and not _should_use_indextts_true_batch(adaptive_batch_size):
            log_business(logger, logging.WARNING, "True batch disabled due to CUDA instability; falling back to sequential mode", event="true_batch_disabled", stage="batch_tts")
            sequential_tasks = [entry["task"] for bucket in dynamic_buckets for entry in bucket] + sequential_tasks
            dynamic_buckets = []

        if dynamic_buckets and _should_use_indextts_true_batch(adaptive_batch_size):
            for batch_entries in dynamic_buckets:
                batch_start_position = processed + 1
                batch_end_position = min(processed + len(batch_entries), total)
                display_start_position = min(progress_completed_offset + batch_start_position, progress_total) if progress_total else batch_start_position
                display_end_position = min(progress_completed_offset + batch_end_position, progress_total) if progress_total else batch_end_position
                token_counts = [entry["token_count"] for entry in batch_entries]
                frame_counts = [entry["estimated_frames"] for entry in batch_entries]
                emit_progress(
                    "generate_batch_tts",
                    "tts_generate",
                    int((progress_completed_offset + processed) / progress_total * 100) if progress_total else 0,
                    f"第 {display_start_position}-{display_end_position}/{progress_total} 条批量生成中",
                    stage_label="正在生成配音",
                    item_index=display_start_position,
                    item_total=progress_total,
                    detail=(
                        f"IndexTTS bucket x{len(batch_entries)} | "
                        f"tokens {min(token_counts)}-{max(token_counts)} | "
                        f"frames {min(frame_counts)}-{max(frame_counts)} | "
                        f"batch {adaptive_batch_size}"
                    )
                )
                try:
                    batch_started_at = time.perf_counter()
                    batch_results = _run_indextts_true_batch(tts, batch_entries, runtime_kwargs, reference_cache)
                    batch_elapsed_ms = (time.perf_counter() - batch_started_at) * 1000.0
                    success_count = sum(1 for result in batch_results if result.get("success"))
                    output_duration_total = sum(float(result.get("duration") or 0.0) for result in batch_results if result.get("success"))
                    bucket_rtf = (batch_elapsed_ms / 1000.0) / max(output_duration_total, 0.001)
                    print(
                        f"[TTSTiming] mode=true_batch size={len(batch_entries)} success={success_count}/{len(batch_entries)} "
                        f"total={batch_elapsed_ms:.0f}ms audio={output_duration_total:.2f}s rtf={bucket_rtf:.3f}"
                    )
                except Exception as batch_error:
                    _handle_fatal_indextts_cuda_error(batch_error, "true_batch")
                    log_error(logger, "True batch execution failed; falling back to single inference", event="true_batch_failed", stage="batch_tts", detail=str(batch_error))
                    batch_results = []
                    for entry in batch_entries:
                        task = entry["task"]
                        normalized_text = entry.get("normalized_text") or _normalize_indextts_text(task["text"])
                        try:
                            duration, retry_mode = _run_indextts_with_safe_retry(
                                tts,
                                ref_audio_path=task["ref_audio_path"],
                                text=task["text"],
                                normalized_text=normalized_text,
                                output_path=task["output_path"],
                                kwargs=runtime_kwargs,
                                target_duration=task.get("duration"),
                                verbose=False
                            )
                            batch_results.append({
                                "index": task.get("index"),
                                "success": True,
                                "audio_path": task["output_path"],
                                "duration": duration,
                                "retry_mode": retry_mode
                            })
                        except Exception as single_error:
                            _handle_fatal_indextts_cuda_error(single_error, "true_batch_fallback_single")
                            error_result = {
                                "index": task.get("index"),
                                "success": False,
                                "error": str(single_error)
                            }
                            if os.path.exists(task["output_path"]):
                                error_result["audio_path"] = task["output_path"]
                                try:
                                    error_result["duration"] = sf.info(task["output_path"]).duration
                                except Exception:
                                    pass
                            batch_results.append(error_result)

                for result in batch_results:
                    item_position = processed + 1
                    if not result.get("success"):
                        emit_issue(
                            "generate_batch_tts",
                            "tts_generate",
                            "warn",
                            "TTS_SEGMENT_FAILED",
                            f"第 {item_position} 条配音生成失败",
                            item_index=item_position,
                            item_total=total,
                            detail=str(result.get("error") or "Unknown batch failure"),
                            suggestion="系统会继续处理后续片段，可稍后重试失败片段"
                        )
                    emit_task_result(result, item_position=item_position)
                    yield result

        for task in sequential_tasks:
            text = task['text']
            normalized_text = _normalize_indextts_text(text)
            ref = task['ref_audio_path']
            out = task['output_path']
            item_position = processed + 1

            log_debug(logger, "Running sequential TTS item", event="sequential_item_started", stage="batch_tts", detail=f"item={item_position}/{total}")
            emit_progress(
                "generate_batch_tts",
                "tts_generate",
                int((progress_completed_offset + processed) / progress_total * 100) if progress_total else 0,
                f"第 {min(progress_completed_offset + item_position, progress_total) if progress_total else item_position}/{progress_total} 条正在生成",
                stage_label="正在生成配音",
                item_index=min(progress_completed_offset + item_position, progress_total) if progress_total else item_position,
                item_total=progress_total
            )

            os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)

            try:
                single_started_at = time.perf_counter()
                dur, retry_mode = _run_indextts_with_safe_retry(
                    tts,
                    ref_audio_path=ref,
                    text=text,
                    normalized_text=normalized_text,
                    output_path=out,
                    kwargs=runtime_kwargs,
                    target_duration=task.get("duration"),
                    verbose=False
                )
                single_elapsed_ms = (time.perf_counter() - single_started_at) * 1000.0
                single_rtf = (single_elapsed_ms / 1000.0) / max(float(dur or 0.001), 0.001)
                print(
                    f"[TTSTiming] mode=sequential total={single_elapsed_ms:.0f}ms "
                    f"audio={dur:.2f}s rtf={single_rtf:.3f} retry={retry_mode} index={task.get('index')}"
                )
                result = {
                    "index": task.get('index'),
                    "audio_path": out,
                    "success": True,
                    "duration": dur,
                    "retry_mode": retry_mode
                }
                emit_task_result(result, item_position=item_position)
                yield result

            except Exception as e:
                _handle_fatal_indextts_cuda_error(e, "sequential_tts")
                single_elapsed_ms = (time.perf_counter() - single_started_at) * 1000.0
                print(f"[TTSTiming] mode=sequential_failed total={single_elapsed_ms:.0f}ms index={task.get('index')}")
                log_error(logger, "Sequential TTS item failed", event="sequential_item_failed", stage="batch_tts", detail=f"index={task.get('index')} error={e}")
                emit_issue(
                    "generate_batch_tts",
                    "tts_generate",
                    "warn",
                    "TTS_SEGMENT_FAILED",
                    f"第 {item_position} 条配音生成失败",
                    item_index=item_position,
                    item_total=total,
                    detail=str(e),
                    suggestion="系统会继续处理后续片段，可稍后重试失败片段"
                )

                error_result = {
                    "index": task.get('index'),
                    "success": False,
                    "error": str(e)
                }

                if os.path.exists(out):
                    error_result["audio_path"] = out
                    try:
                        error_result["duration"] = sf.info(out).duration
                    except Exception:
                        pass

                emit_task_result(error_result, item_position=item_position)
                yield error_result

    except Exception as e:
        log_error(logger, "Batch TTS execution failed", event="batch_tts_failed", stage="batch_tts", detail=str(e))
        emit_issue(
            "generate_batch_tts",
            "tts_generate",
            "error",
            "TTS_BATCH_FAILED",
            "批量配音执行失败",
            detail=str(e),
            suggestion="请查看完整日志，检查模型状态或参考音频"
        )
        import traceback
        traceback.print_exc()
        pass
    finally:
        pass

