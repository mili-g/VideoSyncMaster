import os

from model_profiles import get_asr_profile, resolve_existing_path
from qwen_forced_aligner_service import align_transcript_to_segments
from subtitle_postprocess import clean_segment_text, normalize_output_segments
from transformers5_asr_bridge import (
    get_transformers5_runtime_status,
    run_transformers5_asr_inference,
)

VIBEVOICE_SAFE_MAX_NEW_TOKENS = 256


def _resolve_model_dir(model_name: str | None = None) -> str:
    _, profile = get_asr_profile("vibevoice-asr", "standard")
    candidates = list(profile.get("candidates") or [])
    if model_name and os.path.isdir(model_name):
        return model_name
    if model_name:
        direct_candidate = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", model_name)
        if os.path.isdir(direct_candidate):
            return direct_candidate
    model_dir = resolve_existing_path(candidates)
    if not model_dir:
        raise FileNotFoundError(
            "VibeVoice-ASR model directory not found. Expected one of: " + ", ".join(candidates)
        )
    return model_dir


def get_vibevoice_asr_runtime_status(model_name: str = "VibeVoice-ASR-HF") -> tuple[bool, str | None]:
    try:
        model_dir = _resolve_model_dir(model_name)
    except Exception as error:
        return False, str(error)

    entries = os.listdir(model_dir)
    if not entries:
        return False, (
            "VibeVoice-ASR model directory exists but is empty. "
            "The local model download is incomplete."
        )

    config_path = os.path.join(model_dir, "config.json")
    if not os.path.exists(config_path):
        return False, "VibeVoice-ASR config.json is missing from the model directory."

    weight_candidates = [
        os.path.join(model_dir, "model.safetensors"),
        os.path.join(model_dir, "model.safetensors.index.json"),
        os.path.join(model_dir, "pytorch_model.bin"),
    ]
    if not any(os.path.exists(candidate) for candidate in weight_candidates):
        return False, (
            "VibeVoice-ASR model weights are missing from the model root directory. "
            "Expected model.safetensors, model.safetensors.index.json, or pytorch_model.bin."
        )

    runtime_ok, runtime_detail = get_transformers5_runtime_status()
    if not runtime_ok:
        return False, (
            "VibeVoice-ASR requires the isolated Transformers 5.x runtime, "
            f"but it is not ready: {runtime_detail or 'unknown reason'}"
        )

    return True, runtime_detail


def _resolve_effective_max_new_tokens(max_new_tokens: int | None) -> int:
    requested = max(1, int(max_new_tokens or VIBEVOICE_SAFE_MAX_NEW_TOKENS))
    return min(requested, VIBEVOICE_SAFE_MAX_NEW_TOKENS)


def _should_insert_space_between(left: str, right: str) -> bool:
    if not left or not right:
        return False
    return left[-1:].isalnum() and right[:1].isalnum()


def _join_segment_texts(segments) -> str:
    pieces = []
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


def _overlap_duration(left_start: float, left_end: float, right_start: float, right_end: float) -> float:
    return max(0.0, min(left_end, right_end) - max(left_start, right_start))


def _assign_speakers_from_original_segments(aligned_segments, original_segments):
    speaker_segments = [
        segment for segment in original_segments or []
        if segment.get("speaker") is not None
    ]
    if not speaker_segments:
        return aligned_segments

    assigned = []
    for segment in aligned_segments or []:
        best_speaker = None
        best_overlap = -1.0
        segment_start = float(segment.get("start", 0.0))
        segment_end = float(segment.get("end", segment_start))
        for original in speaker_segments:
            overlap = _overlap_duration(
                segment_start,
                segment_end,
                float(original.get("start", 0.0)),
                float(original.get("end", 0.0)),
            )
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = original.get("speaker")
        updated = dict(segment)
        if best_speaker is not None:
            updated["speaker"] = best_speaker
        assigned.append(updated)
    return assigned


def _realign_vibevoice_segments(audio_path: str, segments, language: str | None, device: str):
    transcript = _join_segment_texts(segments)
    if not transcript:
        return normalize_output_segments(segments)

    aligned_segments = align_transcript_to_segments(
        audio_path=audio_path,
        transcript=transcript,
        language=language,
        device=device,
    )
    if not aligned_segments:
        return normalize_output_segments(segments)

    aligned_segments = _assign_speakers_from_original_segments(aligned_segments, segments)
    for segment in aligned_segments:
        segment.setdefault("provider", "vibevoice-asr")
    return normalize_output_segments(aligned_segments)


def run_vibevoice_asr_inference(
    audio_path: str,
    model_name: str = "VibeVoice-ASR-HF",
    language: str | None = None,
    device: str = "auto",
    max_new_tokens: int = 256,
):
    runtime_ok, runtime_detail = get_vibevoice_asr_runtime_status(model_name)
    if not runtime_ok:
        raise RuntimeError(f"VibeVoice-ASR runtime is unavailable: {runtime_detail or 'unknown reason'}")

    model_dir = _resolve_model_dir(model_name)
    segments = run_transformers5_asr_inference(
        service="vibevoice-asr",
        audio_path=audio_path,
        model_dir=model_dir,
        device=device,
        max_new_tokens=_resolve_effective_max_new_tokens(max_new_tokens),
    )
    try:
        return _realign_vibevoice_segments(audio_path, segments, language, device)
    except Exception:
        return normalize_output_segments(segments)
