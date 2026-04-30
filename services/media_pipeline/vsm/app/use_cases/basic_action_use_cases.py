from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class MergeVideoPreparationResult:
    segments: list[dict[str, Any]]
    messages: list[str]


def test_asr_use_case(
    input_path: str,
    *,
    service: str,
    output_dir: str | None,
    vad_onset: float,
    vad_offset: float,
    language: str | None,
    asr_kwargs: dict[str, Any],
    extra_kwargs: dict[str, Any],
    run_asr: Callable[..., Any],
):
    return run_asr(
        input_path,
        service=service,
        output_dir=output_dir,
        vad_onset=vad_onset,
        vad_offset=vad_offset,
        language=language,
        splitter_kwargs=extra_kwargs,
        **asr_kwargs,
    )


def translate_text_use_case(
    input_text_or_json: str,
    *,
    target_lang: str,
    extra_kwargs: dict[str, Any],
    translate_text: Callable[..., Any],
) -> dict[str, Any]:
    result_raw = translate_text(input_text_or_json, target_lang, **extra_kwargs)
    return result_raw if isinstance(result_raw, dict) else {"success": True, "text": result_raw}


def test_tts_use_case(
    input_text: str,
    *,
    output_path: str,
    language: str,
    ref_audio: str | None,
    runtime_kwargs: dict[str, Any],
    run_tts_func: Callable[..., Any],
):
    success = run_tts_func(input_text, ref_audio, output_path, language=language, **runtime_kwargs)
    return {"success": success, "output": output_path}


def test_align_use_case(
    input_path: str,
    *,
    output_path: str,
    duration: float,
    align_audio: Callable[..., Any],
) -> dict[str, Any]:
    success = align_audio(input_path, output_path, duration)
    return {"success": success, "output": output_path}


def prepare_merge_video_segments(
    json_path: str,
    *,
    strategy: str,
    align_audio: Callable[..., Any],
    get_audio_duration: Callable[..., Any],
) -> MergeVideoPreparationResult:
    with open(json_path, "r", encoding="utf-8") as handle:
        audio_segments = json.load(handle)

    messages: list[str] = []
    for index, segment in enumerate(audio_segments):
        if "start" not in segment or "end" not in segment or "path" not in segment:
            continue

        target_duration = float(segment["end"]) - float(segment["start"])
        audio_segments[index]["duration"] = target_duration
        audio_path = segment["path"]

        if not os.path.exists(audio_path):
            messages.append(f"Audio file not found: {audio_path}")
            continue

        current_duration = get_audio_duration(audio_path)
        if current_duration and current_duration > target_duration + 0.1:
            if strategy in ["frame_blend", "freeze_frame", "rife"]:
                messages.append(
                    f"Segment {index} exceeds slot, but strategy is {strategy}. Skipping audio alignment."
                )
            else:
                messages.append(
                    f"Segment {index} duration ({current_duration:.2f}s) exceeds slot ({target_duration:.2f}s). Aligning..."
                )
                aligned_path = audio_path.replace(".wav", "_aligned.wav")
                if align_audio(audio_path, aligned_path, target_duration):
                    audio_segments[index]["path"] = aligned_path
                else:
                    messages.append(f"Failed to align segment {index}, using original.")
        elif not current_duration:
            messages.append(f"Could not get duration for {audio_path}")

    return MergeVideoPreparationResult(segments=audio_segments, messages=messages)


def merge_video_use_case(
    video_path: str,
    *,
    json_path: str,
    output_path: str,
    strategy: str,
    audio_mix_mode: str,
    align_audio: Callable[..., Any],
    get_audio_duration: Callable[..., Any],
    merge_audios_to_video: Callable[..., Any],
) -> dict[str, Any]:
    prepared = prepare_merge_video_segments(
        json_path,
        strategy=strategy,
        align_audio=align_audio,
        get_audio_duration=get_audio_duration,
    )
    success = merge_audios_to_video(
        video_path,
        prepared.segments,
        output_path,
        strategy=strategy,
        audio_mix_mode=audio_mix_mode,
    )
    return {"success": success, "output": output_path, "messages": prepared.messages}


def analyze_video_use_case(file_path: str, *, analyze_video: Callable[..., Any]):
    return analyze_video(file_path)


def transcode_video_use_case(
    input_path: str,
    *,
    output_path: str,
    transcode_video: Callable[..., Any],
):
    return transcode_video(input_path, output_path)


def dub_video_use_case(
    input_path: str,
    *,
    target_lang: str,
    output_path: str,
    work_dir: str | None,
    asr_service: str,
    vad_onset: float,
    vad_offset: float,
    tts_service: str,
    strategy: str,
    audio_mix_mode: str,
    ori_lang: str | None,
    dub_retry_attempts: int,
    asr_kwargs: dict[str, Any],
    tts_kwargs: dict[str, Any],
    extra_kwargs: dict[str, Any],
    dub_video: Callable[..., Any],
):
    combined_kwargs = {**asr_kwargs, **tts_kwargs, **extra_kwargs}
    return dub_video(
        input_path,
        target_lang,
        output_path,
        work_dir=work_dir,
        asr_service=asr_service,
        vad_onset=vad_onset,
        vad_offset=vad_offset,
        tts_service=tts_service,
        strategy=strategy,
        audio_mix_mode=audio_mix_mode,
        ori_lang=ori_lang,
        dub_retry_attempts=dub_retry_attempts,
        **combined_kwargs,
    )


def check_audio_files_use_case(
    raw_input: str,
    *,
    get_audio_duration: Callable[..., Any],
) -> dict[str, Any]:
    try:
        try:
            file_list = json.loads(raw_input)
        except Exception:
            file_list = [raw_input]

        results = {}
        for path in file_list:
            results[path] = get_audio_duration(path) or 0.0 if os.path.exists(path) else -1.0

        return {"success": True, "durations": results}
    except Exception as error:
        return {"success": False, "error": str(error)}
