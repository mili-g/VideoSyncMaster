from __future__ import annotations

import json
import os
import shutil
import time
import re

from ffmpeg_utils import run_ffmpeg


def get_reference_duration_constraints(tts_service_name):
    normalized = str(tts_service_name or "").strip().lower()
    if normalized == "gptsovits":
        return 3.0, 10.0
    return 2.0, None


def extract_reference_audio(
    *,
    video_path,
    ref_audio_override,
    output_audio,
    start_time,
    duration,
    ffmpeg,
    librosa,
    sf,
    tts_service_name,
    log_business,
    logger,
    logging,
):
    ref_clip_path = output_audio.replace(".wav", "_ref.wav")
    meta = {"trim_duration": None, "too_short": False}
    total_started_at = time.perf_counter()
    min_ref_duration, max_ref_duration = get_reference_duration_constraints(tts_service_name)

    if ref_audio_override and os.path.exists(ref_audio_override):
        log_business(logger, logging.INFO, "Using explicit reference audio", event="reference_audio_selected", stage="prepare_reference", detail=ref_audio_override)
        print(
            f"[RefTiming] mode=explicit_reuse extract=0ms trim=0ms total=0ms "
            f"start={start_time:.2f}s dur={duration:.2f}s path={ref_audio_override}"
        )
        return ref_audio_override, False, meta

    raw_dir = os.path.join(os.path.dirname(output_audio), ".cache", "raw")
    os.makedirs(raw_dir, exist_ok=True)
    raw_ref_path = os.path.join(raw_dir, f"ref_raw_{start_time}.wav")
    extract_duration = max(float(duration or 0.0), min_ref_duration)
    if max_ref_duration is not None:
        extract_duration = min(extract_duration, max_ref_duration)

    extract_started_at = time.perf_counter()
    stream = ffmpeg.input(video_path, ss=start_time, t=extract_duration).output(
        raw_ref_path, acodec="pcm_s16le", ac=1, ar=24000, loglevel="error"
    )
    run_ffmpeg(stream, overwrite_output=True)
    extract_elapsed_ms = (time.perf_counter() - extract_started_at) * 1000.0

    trim_started_at = time.perf_counter()
    try:
        y, sr = librosa.load(raw_ref_path, sr=None)
        y_trim, _ = librosa.effects.trim(y, top_db=20)
        trim_dur = len(y_trim) / sr
        meta["trim_duration"] = trim_dur
        trim_elapsed_ms = (time.perf_counter() - trim_started_at) * 1000.0
        raw_dur = len(y) / sr if sr else extract_duration

        if trim_dur < min_ref_duration:
            print(f"Warning: Extracted ref audio too short after trim ({trim_dur:.2f}s < {min_ref_duration:.1f}s).")
            meta["too_short"] = True
        else:
            print(f"Ref audio trimmed: {raw_dur:.2f}s -> {trim_dur:.2f}s")

        if raw_dur >= min_ref_duration and trim_dur < min_ref_duration:
            print(
                f"Keeping raw reference because trimmed duration {trim_dur:.2f}s "
                f"is below {min_ref_duration:.1f}s for {tts_service_name}."
            )
            meta["too_short"] = False
            sf.write(ref_clip_path, y, sr)
        elif len(y_trim) > 0:
            sf.write(ref_clip_path, y_trim, sr)
        else:
            shutil.copy(raw_ref_path, ref_clip_path)
        total_elapsed_ms = (time.perf_counter() - total_started_at) * 1000.0
        print(
            f"[RefTiming] extract={extract_elapsed_ms:.0f}ms trim={trim_elapsed_ms:.0f}ms total={total_elapsed_ms:.0f}ms "
            f"start={start_time:.2f}s dur={extract_duration:.2f}s"
        )
    except Exception as trim_err:
        trim_elapsed_ms = (time.perf_counter() - trim_started_at) * 1000.0
        print(f"Warning: Failed to trim silence from ref: {trim_err}")
        shutil.copy(raw_ref_path, ref_clip_path)
        total_elapsed_ms = (time.perf_counter() - total_started_at) * 1000.0
        print(
            f"[RefTiming] extract={extract_elapsed_ms:.0f}ms trim_failed_after={trim_elapsed_ms:.0f}ms total={total_elapsed_ms:.0f}ms "
            f"start={start_time:.2f}s dur={extract_duration:.2f}s"
        )

    return ref_clip_path, True, meta


def parse_nearby_ref_audios(raw_value):
    if not raw_value:
        return []

    if isinstance(raw_value, list):
        parsed_refs = []
        for item in raw_value:
            if isinstance(item, str) and os.path.exists(item):
                parsed_refs.append({"audio_path": item, "ref_text": ""})
            elif isinstance(item, dict):
                audio_path = item.get("audio_path") or item.get("path")
                if isinstance(audio_path, str) and os.path.exists(audio_path):
                    parsed_refs.append({"audio_path": audio_path, "ref_text": str(item.get("ref_text") or "")})
        return parsed_refs

    try:
        parsed = json.loads(raw_value)
        if isinstance(parsed, list):
            return parse_nearby_ref_audios(parsed)
    except Exception:
        pass

    return []


def collect_nearby_success_refs(index, success_map, max_refs=2):
    if not success_map:
        return []

    candidates = []
    for candidate_index, success_info in success_map.items():
        if candidate_index == index:
            continue
        if isinstance(success_info, dict):
            audio_path = success_info.get("audio_path")
            ref_text = str(success_info.get("ref_text") or "")
        else:
            audio_path = success_info
            ref_text = ""
        if not audio_path or not os.path.exists(audio_path):
            continue
        candidates.append((abs(int(candidate_index) - int(index)), int(candidate_index), audio_path, ref_text))

    candidates.sort(key=lambda item: (item[0], item[1]))
    refs = []
    seen = set()
    for _, _, audio_path, ref_text in candidates:
        if audio_path in seen:
            continue
        seen.add(audio_path)
        refs.append({"audio_path": audio_path, "ref_text": ref_text})
        if len(refs) >= max_refs:
            break
    return refs


def with_qwen_reference_text(base_kwargs, tts_service_name, ref_text):
    adjusted_kwargs = dict(base_kwargs or {})
    if tts_service_name == "qwen":
        adjusted_kwargs["qwen_ref_text"] = str(ref_text or "")
    elif tts_service_name == "gptsovits":
        adjusted_kwargs["gpt_sovits_prompt_text"] = str(ref_text or "")
    return adjusted_kwargs


def resolve_reference_transcript(segment, default_text=""):
    if isinstance(segment, dict):
        for key in ("source_text", "original_text", "fallback_ref_text", "text"):
            value = str(segment.get(key) or "").strip()
            if value:
                return value
    return str(default_text or "").strip()


def get_effective_retry_attempts(task, max_retry_attempts, tts_service_name):
    attempts = max(int(max_retry_attempts or 0), 0)
    if attempts == 0:
        return 0

    if not isinstance(task, dict):
        return attempts

    if task.get("skip_segment_retry"):
        return 0

    duration = float(task.get("duration") or 0.0)
    text_len = len(str(task.get("text") or "").strip())

    if tts_service_name == "indextts":
        if duration <= 0.8 or text_len <= 6:
            return min(attempts, 1)
        if duration <= 1.5 or text_len <= 16:
            return min(attempts, 2)

    return attempts


def _estimate_text_units(text):
    content = re.sub(r"\s+", "", str(text or ""))
    content = re.sub(r"[^\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]", "", content)
    return len(content)


def build_batch_tts_tasks(
    *,
    video_path,
    segments,
    work_dir,
    args_ref_audio,
    voice_mode,
    official_fast_mode,
    explicit_qwen_ref_text,
    shared_ref_path,
    shared_ref_meta,
    tts_service_name,
    ffmpeg,
    librosa,
    sf,
    get_audio_duration,
    log_prefix,
):
    tasks = []
    normalized_voice_mode = str(voice_mode or "clone").strip().lower()
    official_fast_mode = bool(official_fast_mode)
    total_extract_ms = 0.0
    total_trim_ms = 0.0
    total_ref_ms = 0.0
    prepared_ref_count = 0
    normalized_tts_service_name = str(tts_service_name or "").strip().lower()
    use_shared_reference_as_primary = (
        normalized_tts_service_name == "gptsovits"
        and shared_ref_path
        and os.path.exists(shared_ref_path)
        and not (args_ref_audio and os.path.exists(args_ref_audio))
    )
    has_explicit_reference = bool(args_ref_audio and os.path.exists(args_ref_audio))
    min_ref_duration = 3.0 if normalized_tts_service_name == "gptsovits" else 2.0
    max_ref_duration = 10.0 if normalized_tts_service_name == "gptsovits" else None

    for i, seg in enumerate(segments):
        final_idx = seg.get("original_index", i)
        text = seg.get("text", "")
        start = float(seg.get("start", 0))
        end = float(seg.get("end", 0))
        duration = end - start
        segment_trim_dur = None

        extract_start = start
        extract_duration = duration
        if duration < min_ref_duration:
            padding = (min_ref_duration - duration) / 2
            extract_start = max(0, start - padding)
            extract_duration = duration + (padding * 2)
        if max_ref_duration is not None and extract_duration > max_ref_duration:
            extract_duration = max_ref_duration

        out_path = (
            seg.get("audioPath")
            or seg.get("audio_path")
            or seg.get("output_path")
            or os.path.join(work_dir, f"segment_{final_idx}.wav")
        )
        segment_ref_text = resolve_reference_transcript(seg)
        shared_ref_text = str((shared_ref_meta or {}).get("text") or "").strip()
        text_units = _estimate_text_units(text)
        prefer_single_pass = (
            normalized_tts_service_name == "gptsovits"
            and (
                (duration <= 0.65 or text_units <= 5)
                if has_explicit_reference
                else (duration <= 1.2 or text_units <= 10)
            )
        )

        if use_shared_reference_as_primary:
            ref_path = shared_ref_path
            print(
                f"[RefTiming] segment={i} mode=gptsovits_shared_primary extract=0ms trim=0ms total=0ms "
                f"range={extract_start:.2f}-{extract_start + extract_duration:.2f}s path={ref_path}"
            )
        elif normalized_voice_mode == "narration" and shared_ref_path and os.path.exists(shared_ref_path):
            ref_path = shared_ref_path
            print(
                f"[RefTiming] segment={i} mode=shared_reuse extract=0ms trim=0ms total=0ms "
                f"range={extract_start:.2f}-{extract_start + extract_duration:.2f}s path={ref_path}"
            )
        elif args_ref_audio and os.path.exists(args_ref_audio):
            ref_path = args_ref_audio
            print(
                f"[RefTiming] segment={i} mode=explicit_reuse extract=0ms trim=0ms total=0ms "
                f"range={extract_start:.2f}-{extract_start + extract_duration:.2f}s path={ref_path}"
            )
        else:
            raw_dir = os.path.join(work_dir, ".cache", "raw")
            os.makedirs(raw_dir, exist_ok=True)

            raw_ref_path = os.path.join(raw_dir, f"ref_raw_{i}_{start}.wav")
            ref_path = os.path.join(work_dir, f"ref_{i}_{start}.wav")

            try:
                ref_total_started_at = time.perf_counter()
                extract_started_at = time.perf_counter()
                stream = ffmpeg.input(video_path, ss=extract_start, t=extract_duration).output(
                    raw_ref_path, acodec="pcm_s16le", ac=1, ar=24000, loglevel="error"
                )
                run_ffmpeg(stream, overwrite_output=True)
                extract_elapsed_ms = (time.perf_counter() - extract_started_at) * 1000.0

                try:
                    raw_dur = get_audio_duration(raw_ref_path)
                    print(f"  [Ref Check] Segment {i} ({start}-{end}): raw duration {raw_dur}s", flush=True)
                except Exception:
                    raw_dur = extract_duration

                try:
                    trim_started_at = time.perf_counter()
                    y, sr = librosa.load(raw_ref_path, sr=None)
                    y_trim, _ = librosa.effects.trim(y, top_db=20)
                    trim_dur = len(y_trim) / sr
                    segment_trim_dur = trim_dur
                    trim_elapsed_ms = (time.perf_counter() - trim_started_at) * 1000.0

                    if trim_dur < 0.1:
                        print(f"  [Ref Check] Segment {i} warning: trimmed duration {trim_dur:.2f}s is very short.")
                    else:
                        print(f"  [Ref Check] Segment {i} trimmed {len(y)/sr:.2f}s -> {trim_dur:.2f}s")

                    if (
                        normalized_tts_service_name == "gptsovits"
                        and raw_dur is not None
                        and raw_dur >= min_ref_duration
                        and trim_dur < min_ref_duration
                    ):
                        print(
                            f"  [Ref Check] Segment {i} keeping raw reference for GPT-SoVITS "
                            f"because trimmed duration {trim_dur:.2f}s is below {min_ref_duration:.1f}s."
                        )
                        segment_trim_dur = raw_dur
                        shutil.copy(raw_ref_path, ref_path)
                    elif len(y_trim) > 0:
                        sf.write(ref_path, y_trim, sr)
                    else:
                        shutil.copy(raw_ref_path, ref_path)
                except Exception as trim_err:
                    trim_elapsed_ms = (time.perf_counter() - trim_started_at) * 1000.0
                    print(f"  [Ref Check] Segment {i} trim failed: {trim_err}")
                    shutil.copy(raw_ref_path, ref_path)

                ref_total_elapsed_ms = (time.perf_counter() - ref_total_started_at) * 1000.0
                total_extract_ms += extract_elapsed_ms
                total_trim_ms += trim_elapsed_ms
                total_ref_ms += ref_total_elapsed_ms
                prepared_ref_count += 1
                print(
                    f"[RefTiming] segment={i} extract={extract_elapsed_ms:.0f}ms trim={trim_elapsed_ms:.0f}ms "
                    f"total={ref_total_elapsed_ms:.0f}ms range={extract_start:.2f}-{extract_start + extract_duration:.2f}s"
                )
            except Exception as e:
                print(f"{log_prefix} Segment {i} failed to extract reference audio: {e}")
                continue

        tasks.append(
            {
                "text": text,
                "ref_audio_path": ref_path,
                "output_path": out_path,
                "index": final_idx,
                "ref_text": (
                    str(explicit_qwen_ref_text or "")
                    if (args_ref_audio and os.path.exists(args_ref_audio))
                    else (
                        shared_ref_text
                        if use_shared_reference_as_primary
                        else (
                        shared_ref_text
                        if (normalized_voice_mode == "narration" and shared_ref_path and os.path.exists(shared_ref_path))
                        else (segment_ref_text or shared_ref_text)
                        )
                    )
                ),
                "duration": max(duration, 0.1),
                "skip_segment_retry": bool(
                    ((use_shared_reference_as_primary and not prefer_single_pass) or (segment_trim_dur is not None and segment_trim_dur < 0.5))
                ),
                "fallback_ref_audio": shared_ref_path if (shared_ref_path and shared_ref_path != ref_path) else None,
                "fallback_ref_text": shared_ref_text,
                "start": start,
                "end": end,
                "text_units": text_units,
                "prefer_single_pass": prefer_single_pass,
            }
        )

    if prepared_ref_count > 0:
        print(
            f"[RefTiming] batch_total segments={prepared_ref_count} "
            f"extract_total={total_extract_ms:.0f}ms trim_total={total_trim_ms:.0f}ms total={total_ref_ms:.0f}ms "
            f"avg_total={total_ref_ms / prepared_ref_count:.0f}ms"
        )

    return tasks
