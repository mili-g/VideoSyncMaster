from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class ExecutionServices:
    dispatch_basic_action: Callable[..., Any]
    list_basic_actions: Callable[[], list[str]]
    get_tts_runner: Callable[..., Any]
    run_asr: Callable[..., Any]
    translate_text: Callable[..., Any]
    align_audio: Callable[..., Any]
    get_audio_duration: Callable[..., Any]
    merge_audios_to_video: Callable[..., Any]
    analyze_video: Callable[..., Any]
    transcode_video: Callable[..., Any]
    dub_video: Callable[..., Any]
    handle_generate_single_tts: Callable[..., Any]
    handle_generate_batch_tts: Callable[..., Any]
    handle_prepare_reference_audio: Callable[..., Any]
    ffmpeg: Any
    librosa: Any
    sf: Any
    warmup_tts_runtime: Callable[..., Any]
    switch_runtime_profile: Callable[..., Any]
