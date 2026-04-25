import json
import os
import shutil
import traceback
import time
from event_protocol import emit_issue, emit_progress, emit_stage


def _build_retry_tts_kwargs(base_kwargs, *, tts_service_name, attempt, use_fallback_reference=False):
    adjusted_kwargs = dict(base_kwargs or {})
    if tts_service_name != "indextts":
        return adjusted_kwargs

    attempt = max(int(attempt or 1), 1)
    requested_mel_cap = adjusted_kwargs.get("max_mel_tokens", adjusted_kwargs.get("max_new_tokens", 1500))
    try:
        requested_mel_cap = max(int(requested_mel_cap), 240)
    except Exception:
        requested_mel_cap = 1500
    requested_segment_limit = adjusted_kwargs.get("max_text_tokens_per_segment", 80)
    try:
        requested_segment_limit = max(int(requested_segment_limit), 24)
    except Exception:
        requested_segment_limit = 80

    if use_fallback_reference:
        adjusted_kwargs["temperature"] = min(float(adjusted_kwargs.get("temperature", 0.8)), 0.6)
        adjusted_kwargs["top_p"] = min(float(adjusted_kwargs.get("top_p", 0.8)), 0.82)
        adjusted_kwargs["top_k"] = min(int(adjusted_kwargs.get("top_k", 5)), 18)
        adjusted_kwargs["repetition_penalty"] = max(float(adjusted_kwargs.get("repetition_penalty", 1.0)), 1.18)
        adjusted_kwargs["max_text_tokens_per_segment"] = min(requested_segment_limit, 56)
        adjusted_kwargs["max_mel_tokens"] = min(requested_mel_cap, 520)
        adjusted_kwargs["max_new_tokens"] = adjusted_kwargs["max_mel_tokens"]
        adjusted_kwargs["do_sample"] = True
        return adjusted_kwargs

    if attempt == 1:
        adjusted_kwargs["max_text_tokens_per_segment"] = min(requested_segment_limit, 72)
        adjusted_kwargs["max_mel_tokens"] = min(requested_mel_cap, 840)
        adjusted_kwargs["max_new_tokens"] = adjusted_kwargs["max_mel_tokens"]
        return adjusted_kwargs

    if attempt == 2:
        adjusted_kwargs["temperature"] = min(float(adjusted_kwargs.get("temperature", 0.8)), 0.72)
        adjusted_kwargs["top_p"] = min(float(adjusted_kwargs.get("top_p", 0.8)), 0.9)
        adjusted_kwargs["top_k"] = min(int(adjusted_kwargs.get("top_k", 5)), 30)
        adjusted_kwargs["repetition_penalty"] = max(float(adjusted_kwargs.get("repetition_penalty", 1.0)), 1.10)
        adjusted_kwargs["max_text_tokens_per_segment"] = min(requested_segment_limit, 64)
        adjusted_kwargs["max_mel_tokens"] = min(requested_mel_cap, 680)
        adjusted_kwargs["max_new_tokens"] = adjusted_kwargs["max_mel_tokens"]
        adjusted_kwargs["do_sample"] = True
        return adjusted_kwargs

    adjusted_kwargs["temperature"] = min(float(adjusted_kwargs.get("temperature", 0.8)), 0.62)
    adjusted_kwargs["top_p"] = min(float(adjusted_kwargs.get("top_p", 0.8)), 0.84)
    adjusted_kwargs["top_k"] = min(int(adjusted_kwargs.get("top_k", 5)), 20)
    adjusted_kwargs["repetition_penalty"] = max(float(adjusted_kwargs.get("repetition_penalty", 1.0)), 1.16)
    adjusted_kwargs["max_text_tokens_per_segment"] = min(requested_segment_limit, 56)
    adjusted_kwargs["max_mel_tokens"] = min(requested_mel_cap, 560)
    adjusted_kwargs["max_new_tokens"] = adjusted_kwargs["max_mel_tokens"]
    adjusted_kwargs["do_sample"] = True
    return adjusted_kwargs


def _extract_reference_audio(
    *,
    video_path,
    ref_audio_override,
    output_audio,
    start_time,
    duration,
    ffmpeg,
    librosa,
    sf
):
    ref_clip_path = output_audio.replace(".wav", "_ref.wav")
    meta = {"trim_duration": None, "too_short": False}
    total_started_at = time.perf_counter()

    if ref_audio_override and os.path.exists(ref_audio_override):
        print(f"Using explicit reference audio: {ref_audio_override}")
        print(
            f"[RefTiming] mode=explicit_reuse extract=0ms trim=0ms total=0ms "
            f"start={start_time:.2f}s dur={duration:.2f}s path={ref_audio_override}"
        )
        return ref_audio_override, False, meta

    raw_dir = os.path.join(os.path.dirname(output_audio), ".cache", "raw")
    os.makedirs(raw_dir, exist_ok=True)
    raw_ref_path = os.path.join(raw_dir, f"ref_raw_{start_time}.wav")

    extract_started_at = time.perf_counter()
    ffmpeg.input(video_path, ss=start_time, t=duration).output(
        raw_ref_path, acodec="pcm_s16le", ac=1, ar=24000, loglevel="error"
    ).run(overwrite_output=True)
    extract_elapsed_ms = (time.perf_counter() - extract_started_at) * 1000.0

    trim_started_at = time.perf_counter()
    try:
        y, sr = librosa.load(raw_ref_path, sr=None)
        y_trim, _ = librosa.effects.trim(y, top_db=20)
        trim_dur = len(y_trim) / sr
        meta["trim_duration"] = trim_dur
        trim_elapsed_ms = (time.perf_counter() - trim_started_at) * 1000.0

        if trim_dur < 0.5:
            print(f"Warning: Extracted ref audio too short after trim ({trim_dur:.2f}s < 0.5s). May cause hallucination!")
            meta["too_short"] = True
        else:
            print(f"Ref audio trimmed: {len(y)/sr:.2f}s -> {trim_dur:.2f}s")

        if len(y_trim) > 0:
            sf.write(ref_clip_path, y_trim, sr)
        else:
            shutil.copy(raw_ref_path, ref_clip_path)
        total_elapsed_ms = (time.perf_counter() - total_started_at) * 1000.0
        print(
            f"[RefTiming] extract={extract_elapsed_ms:.0f}ms trim={trim_elapsed_ms:.0f}ms total={total_elapsed_ms:.0f}ms "
            f"start={start_time:.2f}s dur={duration:.2f}s"
        )
    except Exception as trim_err:
        trim_elapsed_ms = (time.perf_counter() - trim_started_at) * 1000.0
        print(f"Warning: Failed to trim silence from ref: {trim_err}")
        shutil.copy(raw_ref_path, ref_clip_path)
        total_elapsed_ms = (time.perf_counter() - total_started_at) * 1000.0
        print(
            f"[RefTiming] extract={extract_elapsed_ms:.0f}ms trim_failed_after={trim_elapsed_ms:.0f}ms total={total_elapsed_ms:.0f}ms "
            f"start={start_time:.2f}s dur={duration:.2f}s"
        )

    return ref_clip_path, True, meta


def _parse_nearby_ref_audios(raw_value):
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
                    parsed_refs.append({
                        "audio_path": audio_path,
                        "ref_text": str(item.get("ref_text") or "")
                    })
        return parsed_refs

    try:
        parsed = json.loads(raw_value)
        if isinstance(parsed, list):
            return _parse_nearby_ref_audios(parsed)
    except Exception:
        pass

    return []


def _collect_nearby_success_refs(index, success_map, max_refs=2):
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


def _with_qwen_reference_text(base_kwargs, tts_service_name, ref_text):
    adjusted_kwargs = dict(base_kwargs or {})
    if tts_service_name == "qwen":
        adjusted_kwargs["qwen_ref_text"] = str(ref_text or "")
    return adjusted_kwargs


def _get_effective_retry_attempts(task, max_retry_attempts, tts_service_name):
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


def _build_batch_tts_tasks(
    *,
    video_path,
    segments,
    work_dir,
    args_ref_audio,
    voice_mode,
    explicit_qwen_ref_text,
    shared_ref_path,
    shared_ref_meta,
    ffmpeg,
    librosa,
    sf,
    get_audio_duration,
    log_prefix
):
    tasks = []
    normalized_voice_mode = str(voice_mode or "clone").strip().lower()
    total_extract_ms = 0.0
    total_trim_ms = 0.0
    total_ref_ms = 0.0
    prepared_ref_count = 0

    for i, seg in enumerate(segments):
        final_idx = seg.get("original_index", i)
        text = seg.get("text", "")
        start = float(seg.get("start", 0))
        end = float(seg.get("end", 0))
        duration = end - start
        segment_trim_dur = None

        extract_start = start
        extract_duration = duration
        if duration < 2.0:
            padding = (2.0 - duration) / 2
            extract_start = max(0, start - padding)
            extract_duration = duration + (padding * 2)

        out_path = (
            seg.get("audioPath")
            or seg.get("audio_path")
            or seg.get("output_path")
            or os.path.join(work_dir, f"segment_{i}.wav")
        )

        if normalized_voice_mode == "narration" and shared_ref_path and os.path.exists(shared_ref_path):
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
                ffmpeg.input(video_path, ss=extract_start, t=extract_duration).output(
                    raw_ref_path, acodec="pcm_s16le", ac=1, ar=24000, loglevel="error"
                ).run(overwrite_output=True)
                extract_elapsed_ms = (time.perf_counter() - extract_started_at) * 1000.0

                try:
                    raw_dur = get_audio_duration(raw_ref_path)
                    print(f"  [Ref Check] Segment {i} ({start}-{end}): raw duration {raw_dur}s", flush=True)
                except Exception:
                    pass

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

                    if len(y_trim) > 0:
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

        tasks.append({
            "text": text,
            "ref_audio_path": ref_path,
            "output_path": out_path,
            "index": final_idx,
            "ref_text": (
                str(explicit_qwen_ref_text or "")
                if (args_ref_audio and os.path.exists(args_ref_audio))
                else str((shared_ref_meta or {}).get("text") or seg.get("source_text") or seg.get("original_text") or "")
            ),
            "duration": max(duration, 0.1),
            "skip_segment_retry": bool(segment_trim_dur is not None and segment_trim_dur < 0.5),
            "fallback_ref_audio": shared_ref_path if (shared_ref_path and shared_ref_path != ref_path) else None,
            "fallback_ref_text": str((shared_ref_meta or {}).get("text", "")),
            "start": start,
            "end": end
        })

    if prepared_ref_count > 0:
        print(
            f"[RefTiming] batch_total segments={prepared_ref_count} "
            f"extract_total={total_extract_ms:.0f}ms trim_total={total_trim_ms:.0f}ms total={total_ref_ms:.0f}ms "
            f"avg_total={total_ref_ms / prepared_ref_count:.0f}ms"
        )

    return tasks


def _finalize_batch_tts_results(
    *,
    segments,
    tasks,
    batch_results,
    run_tts_func,
    tts_kwargs,
    tts_service_name,
    target_lang,
    max_retry_attempts,
    get_audio_duration,
    log_prefix,
    progress_completed_offset=0,
    progress_total_override=0
):
    final_output_list = []
    task_result_map = {}
    task_lookup = {int(task["index"]): task for task in tasks}
    task_position_lookup = {
        int(task["index"]): position
        for position, task in enumerate(tasks, start=1)
    }
    nearby_success_map = {}
    total_segments = len(segments)
    total_task_count = len(tasks)
    progress_completed_offset = max(int(progress_completed_offset or 0), 0)
    progress_total = max(int(progress_total_override or 0), progress_completed_offset + total_task_count, total_task_count, total_segments)
    retry_attempts = 0
    retry_successes = 0
    retry_failures = 0
    retry_elapsed_ms = 0.0

    def emit_retry_status(item_index, message, *, detail=None):
        safe_total = progress_total if progress_total > 0 else (total_task_count if total_task_count > 0 else total_segments)
        safe_index = max(1, min(int(item_index), safe_total)) if safe_total > 0 else 1
        emit_progress(
            "generate_batch_tts",
            "tts_generate",
            int((safe_index / safe_total) * 100) if safe_total else 100,
            message,
            stage_label="正在生成配音",
            item_index=safe_index,
            item_total=safe_total,
            detail=detail
        )

    for result in batch_results:
        if not isinstance(result, dict):
            continue
        result_index = result.get("index")
        if result_index is None:
            continue
        task_result_map[int(result_index)] = result

    for i, seg in enumerate(segments):
        final_idx = seg.get("original_index", i)
        task = task_lookup.get(int(final_idx))
        task_position = task_position_lookup.get(int(final_idx), min(i + 1, total_task_count) if total_task_count > 0 else i + 1)
        display_task_position = min(progress_completed_offset + task_position, progress_total) if progress_total > 0 else task_position

        if final_idx in task_result_map:
            res = task_result_map[final_idx]
            res["index"] = final_idx

            if res["success"]:
                start = float(seg.get("start", 0))
                end = float(seg.get("end", 0))
                target_dur = end - start
                output_audio = res.get("audio_path")

                if not output_audio:
                    print(f"{log_prefix} Segment {final_idx} missing audio_path in success result.")
                    res["success"] = False
                    res["error"] = "Missing audio_path in result"
                    final_output_list.append(res)
                    continue

                current_dur = get_audio_duration(output_audio)
                res["duration"] = current_dur or target_dur
                if output_audio and os.path.exists(output_audio):
                    nearby_success_map[final_idx] = {
                        "audio_path": output_audio,
                        "ref_text": task_lookup.get(final_idx, {}).get("text", "")
                    }

            if (not res["success"] or not res.get("audio_path")) and task and run_tts_func:
                retry_output = task["output_path"]
                retry_success = False
                retry_error = res.get("error") or "Batch TTS failed"
                nearby_refs = _collect_nearby_success_refs(final_idx, nearby_success_map)
                effective_retry_attempts = _get_effective_retry_attempts(task, max_retry_attempts, tts_service_name)

                if not retry_success and effective_retry_attempts > 0:
                    for attempt in range(1, effective_retry_attempts + 1):
                        try:
                            emit_retry_status(
                                display_task_position,
                                f"第 {display_task_position}/{progress_total or total_task_count or total_segments} 条重试中",
                                detail=f"使用片段参考重试 {attempt}/{effective_retry_attempts}"
                            )
                            print(f"{log_prefix} Retrying segment {final_idx} ({attempt}/{effective_retry_attempts}) with segment reference...")
                            attempt_kwargs = _build_retry_tts_kwargs(
                                tts_kwargs,
                                tts_service_name=tts_service_name,
                                attempt=attempt,
                                use_fallback_reference=False
                            )
                            attempt_kwargs = _with_qwen_reference_text(
                                attempt_kwargs,
                                tts_service_name,
                                task.get("ref_text", "")
                            )
                            retry_started_at = time.perf_counter()
                            retry_success = run_tts_func(
                                task["text"],
                                task["ref_audio_path"],
                                retry_output,
                                language=target_lang,
                                **attempt_kwargs
                            )
                            attempt_elapsed_ms = (time.perf_counter() - retry_started_at) * 1000.0
                            retry_attempts += 1
                            retry_elapsed_ms += attempt_elapsed_ms
                            if retry_success:
                                retry_successes += 1
                                print(f"[RetryTiming] segment={final_idx} mode=segment_ref attempt={attempt} total={attempt_elapsed_ms:.0f}ms success=1")
                            else:
                                retry_failures += 1
                                print(f"[RetryTiming] segment={final_idx} mode=segment_ref attempt={attempt} total={attempt_elapsed_ms:.0f}ms success=0")
                            if retry_success:
                                retry_error = None
                                break
                            retry_error = "TTS runner returned False"
                        except Exception as retry_exc:
                            retry_error = str(retry_exc)
                            print(f"{log_prefix} Segment {final_idx} retry failed: {retry_exc}")
                            retry_success = False
                elif not retry_success:
                    print(f"{log_prefix} Segment {final_idx} direct segment retries skipped by retry policy.")

                if not retry_success and nearby_refs:
                    for nearby_idx, nearby_ref in enumerate(nearby_refs, start=1):
                        try:
                            emit_retry_status(
                                display_task_position,
                                f"第 {display_task_position}/{progress_total or total_task_count or total_segments} 条重试中",
                                detail=f"使用邻近成功参考重试 {nearby_idx}/{len(nearby_refs)}"
                            )
                            print(f"{log_prefix} Segment {final_idx} trying nearby successful reference {nearby_idx}/{len(nearby_refs)}...")
                            nearby_kwargs = _build_retry_tts_kwargs(
                                tts_kwargs,
                                tts_service_name=tts_service_name,
                                attempt=effective_retry_attempts + nearby_idx,
                                use_fallback_reference=True
                            )
                            nearby_kwargs = _with_qwen_reference_text(
                                nearby_kwargs,
                                tts_service_name,
                                nearby_ref.get("ref_text", "")
                            )
                            retry_started_at = time.perf_counter()
                            retry_success = run_tts_func(
                                task["text"],
                                nearby_ref.get("audio_path"),
                                retry_output,
                                language=target_lang,
                                **nearby_kwargs
                            )
                            attempt_elapsed_ms = (time.perf_counter() - retry_started_at) * 1000.0
                            retry_attempts += 1
                            retry_elapsed_ms += attempt_elapsed_ms
                            if retry_success:
                                retry_successes += 1
                                print(f"[RetryTiming] segment={final_idx} mode=nearby_ref attempt={nearby_idx} total={attempt_elapsed_ms:.0f}ms success=1")
                            else:
                                retry_failures += 1
                                print(f"[RetryTiming] segment={final_idx} mode=nearby_ref attempt={nearby_idx} total={attempt_elapsed_ms:.0f}ms success=0")
                            if retry_success:
                                retry_error = None
                                break
                            retry_error = "Nearby fallback TTS runner returned False"
                        except Exception as nearby_exc:
                            retry_error = str(nearby_exc)
                            print(f"{log_prefix} Segment {final_idx} nearby successful reference failed: {nearby_exc}")
                            retry_success = False

                if not retry_success and task.get("fallback_ref_audio"):
                    try:
                        emit_retry_status(
                            display_task_position,
                            f"第 {display_task_position}/{progress_total or total_task_count or total_segments} 条重试中",
                            detail="切换共享兜底参考音频"
                        )
                        print(f"{log_prefix} Segment {final_idx} switching to shared fallback reference audio...")
                        fallback_kwargs = _build_retry_tts_kwargs(
                            tts_kwargs,
                            tts_service_name=tts_service_name,
                            attempt=effective_retry_attempts + 1,
                            use_fallback_reference=True
                        )
                        fallback_kwargs = _with_qwen_reference_text(
                            fallback_kwargs,
                            tts_service_name,
                            task.get("fallback_ref_text", "")
                        )
                        retry_started_at = time.perf_counter()
                        retry_success = run_tts_func(
                            task["text"],
                            task["fallback_ref_audio"],
                            retry_output,
                            language=target_lang,
                            **fallback_kwargs
                        )
                        attempt_elapsed_ms = (time.perf_counter() - retry_started_at) * 1000.0
                        retry_attempts += 1
                        retry_elapsed_ms += attempt_elapsed_ms
                        if retry_success:
                            retry_successes += 1
                            print(f"[RetryTiming] segment={final_idx} mode=shared_fallback attempt=1 total={attempt_elapsed_ms:.0f}ms success=1")
                        else:
                            retry_failures += 1
                            print(f"[RetryTiming] segment={final_idx} mode=shared_fallback attempt=1 total={attempt_elapsed_ms:.0f}ms success=0")
                        if retry_success:
                            retry_error = None
                        else:
                            retry_error = "Fallback TTS runner returned False"
                    except Exception as fallback_exc:
                        retry_error = str(fallback_exc)
                        print(f"{log_prefix} Segment {final_idx} shared fallback retry failed: {fallback_exc}")
                        retry_success = False

                if retry_success and os.path.exists(retry_output):
                    res = {
                        "index": final_idx,
                        "success": True,
                        "audio_path": retry_output,
                        "duration": get_audio_duration(retry_output) or max(float(seg.get("end", 0)) - float(seg.get("start", 0)), 0.1)
                    }
                    nearby_success_map[final_idx] = {
                        "audio_path": retry_output,
                        "ref_text": task.get("text", "")
                    }
                else:
                    res["success"] = False
                    res["error"] = retry_error or res.get("error") or "TTS generation failed after retries"
                    if not res.get("audio_path") and os.path.exists(retry_output):
                        res["audio_path"] = retry_output

            final_output_list.append(res)
        else:
            retry_result = {
                "index": final_idx,
                "success": False,
                "error": "TTS Task Failed (No result returned). Check logs for details."
            }

            if task and run_tts_func:
                retry_output = task["output_path"]
                retry_success = False
                retry_error = retry_result["error"]
                nearby_refs = _collect_nearby_success_refs(final_idx, nearby_success_map)
                effective_retry_attempts = _get_effective_retry_attempts(task, max_retry_attempts, tts_service_name)

                if not retry_success and effective_retry_attempts > 0:
                    for attempt in range(1, effective_retry_attempts + 1):
                        try:
                            emit_retry_status(
                                display_task_position,
                                f"第 {display_task_position}/{progress_total or total_task_count or total_segments} 条重试中",
                                detail=f"缺失片段补生成 {attempt}/{effective_retry_attempts}"
                            )
                            print(f"{log_prefix} Retrying missing segment {final_idx} ({attempt}/{effective_retry_attempts}) with segment reference...")
                            print(
                                f"[RefTiming] segment={final_idx} mode=reuse_prepared_ref "
                                f"extract=0ms trim=0ms total=0ms path={task['ref_audio_path']}"
                            )
                            attempt_kwargs = _build_retry_tts_kwargs(
                                tts_kwargs,
                                tts_service_name=tts_service_name,
                                attempt=attempt,
                                use_fallback_reference=False
                            )
                            attempt_kwargs = _with_qwen_reference_text(
                                attempt_kwargs,
                                tts_service_name,
                                task.get("ref_text", "")
                            )
                            retry_started_at = time.perf_counter()
                            retry_success = run_tts_func(
                                task["text"],
                                task["ref_audio_path"],
                                retry_output,
                                language=target_lang,
                                **attempt_kwargs
                            )
                            attempt_elapsed_ms = (time.perf_counter() - retry_started_at) * 1000.0
                            retry_attempts += 1
                            retry_elapsed_ms += attempt_elapsed_ms
                            if retry_success:
                                retry_successes += 1
                                print(f"[RetryTiming] segment={final_idx} mode=missing_segment_ref attempt={attempt} total={attempt_elapsed_ms:.0f}ms success=1")
                            else:
                                retry_failures += 1
                                print(f"[RetryTiming] segment={final_idx} mode=missing_segment_ref attempt={attempt} total={attempt_elapsed_ms:.0f}ms success=0")
                            if retry_success:
                                retry_error = None
                                break
                            retry_error = "TTS runner returned False"
                        except Exception as retry_exc:
                            retry_error = str(retry_exc)
                            print(f"{log_prefix} Missing segment {final_idx} retry failed: {retry_exc}")
                            retry_success = False
                elif not retry_success:
                    print(f"{log_prefix} Missing segment {final_idx} direct segment retries skipped by retry policy.")

                if not retry_success and nearby_refs:
                    for nearby_idx, nearby_ref in enumerate(nearby_refs, start=1):
                        try:
                            emit_retry_status(
                                display_task_position,
                                f"第 {display_task_position}/{progress_total or total_task_count or total_segments} 条重试中",
                                detail=f"缺失片段使用邻近成功参考 {nearby_idx}/{len(nearby_refs)}"
                            )
                            print(f"{log_prefix} Missing segment {final_idx} trying nearby successful reference {nearby_idx}/{len(nearby_refs)}...")
                            print(
                                f"[RefTiming] segment={final_idx} mode=reuse_nearby_ref "
                                f"extract=0ms trim=0ms total=0ms path={nearby_ref.get('audio_path', '')}"
                            )
                            nearby_kwargs = _build_retry_tts_kwargs(
                                tts_kwargs,
                                tts_service_name=tts_service_name,
                                attempt=effective_retry_attempts + nearby_idx,
                                use_fallback_reference=True
                            )
                            nearby_kwargs = _with_qwen_reference_text(
                                nearby_kwargs,
                                tts_service_name,
                                nearby_ref.get("ref_text", "")
                            )
                            retry_started_at = time.perf_counter()
                            retry_success = run_tts_func(
                                task["text"],
                                nearby_ref.get("audio_path"),
                                retry_output,
                                language=target_lang,
                                **nearby_kwargs
                            )
                            attempt_elapsed_ms = (time.perf_counter() - retry_started_at) * 1000.0
                            retry_attempts += 1
                            retry_elapsed_ms += attempt_elapsed_ms
                            if retry_success:
                                retry_successes += 1
                                print(f"[RetryTiming] segment={final_idx} mode=missing_nearby_ref attempt={nearby_idx} total={attempt_elapsed_ms:.0f}ms success=1")
                            else:
                                retry_failures += 1
                                print(f"[RetryTiming] segment={final_idx} mode=missing_nearby_ref attempt={nearby_idx} total={attempt_elapsed_ms:.0f}ms success=0")
                            if retry_success:
                                retry_error = None
                                break
                            retry_error = "Nearby fallback TTS runner returned False"
                        except Exception as nearby_exc:
                            retry_error = str(nearby_exc)
                            print(f"{log_prefix} Missing segment {final_idx} nearby successful reference failed: {nearby_exc}")
                            retry_success = False

                if not retry_success and task.get("fallback_ref_audio"):
                    try:
                        emit_retry_status(
                            display_task_position,
                            f"第 {display_task_position}/{progress_total or total_task_count or total_segments} 条重试中",
                            detail="缺失片段切换共享兜底参考音频"
                        )
                        print(f"{log_prefix} Missing segment {final_idx} switching to shared fallback reference audio...")
                        fallback_kwargs = _build_retry_tts_kwargs(
                            tts_kwargs,
                            tts_service_name=tts_service_name,
                            attempt=effective_retry_attempts + 1,
                            use_fallback_reference=True
                        )
                        fallback_kwargs = _with_qwen_reference_text(
                            fallback_kwargs,
                            tts_service_name,
                            task.get("fallback_ref_text", "")
                        )
                        retry_started_at = time.perf_counter()
                        retry_success = run_tts_func(
                            task["text"],
                            task["fallback_ref_audio"],
                            retry_output,
                            language=target_lang,
                            **fallback_kwargs
                        )
                        attempt_elapsed_ms = (time.perf_counter() - retry_started_at) * 1000.0
                        retry_attempts += 1
                        retry_elapsed_ms += attempt_elapsed_ms
                        if retry_success:
                            retry_successes += 1
                            print(f"[RetryTiming] segment={final_idx} mode=missing_shared_fallback attempt=1 total={attempt_elapsed_ms:.0f}ms success=1")
                        else:
                            retry_failures += 1
                            print(f"[RetryTiming] segment={final_idx} mode=missing_shared_fallback attempt=1 total={attempt_elapsed_ms:.0f}ms success=0")
                        if retry_success:
                            retry_error = None
                        else:
                            retry_error = "Fallback TTS runner returned False"
                    except Exception as fallback_exc:
                        retry_error = str(fallback_exc)
                        print(f"{log_prefix} Missing segment {final_idx} shared fallback retry failed: {fallback_exc}")
                        retry_success = False

                if retry_success and os.path.exists(retry_output):
                    retry_result = {
                        "index": final_idx,
                        "success": True,
                        "audio_path": retry_output,
                        "duration": get_audio_duration(retry_output) or max(float(seg.get("end", 0)) - float(seg.get("start", 0)), 0.1)
                    }
                    nearby_success_map[final_idx] = {
                        "audio_path": retry_output,
                        "ref_text": task.get("text", "")
                    }
                else:
                    retry_result["error"] = retry_error or retry_result["error"]
                    if os.path.exists(retry_output):
                        retry_result["audio_path"] = retry_output

            final_output_list.append(retry_result)

    if retry_attempts > 0:
        print(
            f"[RetryTiming] total attempts={retry_attempts} success={retry_successes} "
            f"fail={retry_failures} total={retry_elapsed_ms:.0f}ms "
            f"avg={retry_elapsed_ms / retry_attempts:.0f}ms"
        )

    return final_output_list


def generate_batch_tts_results(
    *,
    video_path,
    segments,
    work_dir,
    target_lang,
    tts_service_name,
    tts_kwargs,
    args_ref_audio,
    explicit_qwen_ref_text,
    max_retry_attempts,
    get_tts_runner,
    get_audio_duration,
    ffmpeg,
    librosa,
    sf,
    progress_completed_offset=0,
    progress_total_override=0,
    log_prefix="[BatchTTS]"
):
    emit_stage(
        "generate_batch_tts",
        "prepare_reference",
        "正在提取参考音频",
        stage_label="正在准备参考音频"
    )
    run_tts_func, run_batch_tts_func = get_tts_runner(tts_service_name)
    if not run_batch_tts_func:
        emit_issue(
            "generate_batch_tts",
            "tts_generate",
            "error",
            "TTS_INIT_FAILED",
            f"初始化批量 TTS 失败: {tts_service_name}"
        )
        return {"success": False, "error": f"Failed to init Batch TTS: {tts_service_name}"}

    shared_ref_path = None
    shared_ref_should_clean = False
    shared_ref_meta = None
    voice_mode = str(tts_kwargs.get("voice_mode") or "clone").strip().lower()

    try:
        if not (args_ref_audio and os.path.exists(args_ref_audio)):
            try:
                shared_ref_path, shared_ref_should_clean, shared_ref_meta = prepare_global_reference_audio(
                    video_path=video_path,
                    work_dir=work_dir,
                    segments=segments,
                    ref_audio_override=args_ref_audio,
                    ffmpeg=ffmpeg,
                    librosa=librosa,
                    sf=sf
                )
            except Exception as shared_ref_error:
                print(f"{log_prefix} Failed to prepare shared fallback reference audio: {shared_ref_error}")
                emit_issue(
                    "generate_batch_tts",
                    "prepare_reference",
                    "warn",
                    "REFERENCE_PREPARE_FAILED",
                    "共享兜底参考音频准备失败",
                    detail=str(shared_ref_error),
                    suggestion="系统将继续执行，但部分片段重试能力可能下降"
                )
                shared_ref_path = None
                shared_ref_should_clean = False

        tasks = _build_batch_tts_tasks(
            video_path=video_path,
            segments=segments,
            work_dir=work_dir,
            args_ref_audio=args_ref_audio,
            voice_mode=voice_mode,
            explicit_qwen_ref_text=explicit_qwen_ref_text,
            shared_ref_path=shared_ref_path,
            shared_ref_meta=shared_ref_meta,
            ffmpeg=ffmpeg,
            librosa=librosa,
            sf=sf,
            get_audio_duration=get_audio_duration,
            log_prefix=log_prefix
        )

        print(f"\n[Stage 2] Running TTS for {len(tasks)} tasks (skipped {len(segments) - len(tasks)} invalid items)...")
        progress_completed_offset = max(int(progress_completed_offset or 0), 0)
        progress_total_override = max(int(progress_total_override or 0), 0)

        emit_stage(
            "generate_batch_tts",
            "tts_generate",
            f"正在为 {max(progress_total_override, progress_completed_offset + len(tasks), len(tasks))} 条任务生成配音",
            stage_label="正在生成配音"
        )

        if not tasks:
            print("No valid tasks available.")
            return {"success": True, "results": []}

        batch_runtime_kwargs = dict(tts_kwargs)
        batch_runtime_kwargs["batch_size"] = int(batch_runtime_kwargs.get("batch_size") or 1)
        batch_runtime_kwargs["progress_completed_offset"] = progress_completed_offset
        batch_runtime_kwargs["progress_total_override"] = progress_total_override
        batch_results = list(run_batch_tts_func(tasks, language=target_lang, **batch_runtime_kwargs))

        final_output_list = _finalize_batch_tts_results(
            segments=segments,
            tasks=tasks,
            batch_results=batch_results,
            run_tts_func=run_tts_func,
            tts_kwargs=tts_kwargs,
            tts_service_name=tts_service_name,
            target_lang=target_lang,
            max_retry_attempts=max_retry_attempts,
            get_audio_duration=get_audio_duration,
            log_prefix=log_prefix,
            progress_completed_offset=progress_completed_offset,
            progress_total_override=progress_total_override
        )

        return {"success": True, "results": final_output_list}
    finally:
        try:
            cache_dir_to_remove = os.path.join(work_dir, ".cache")
            if os.path.exists(cache_dir_to_remove):
                shutil.rmtree(cache_dir_to_remove)
        except Exception:
            pass

        try:
            if shared_ref_should_clean and shared_ref_path and os.path.exists(shared_ref_path):
                os.remove(shared_ref_path)
        except Exception:
            pass


def _select_reference_candidate(segments):
    best = None
    best_score = float("-inf")

    for index, seg in enumerate(segments):
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", start))
        duration = max(0.0, end - start)
        text = str(seg.get("text", "")).strip()
        text_len = len(text)

        if duration < 0.8 or not text:
            continue

        score = 0.0
        if 2.0 <= duration <= 6.0:
            score += 6.0
        else:
            score += max(0.0, 4.0 - abs(duration - 3.5))

        if 8 <= text_len <= 80:
            score += 3.0
        else:
            score += max(0.0, 2.0 - abs(text_len - 24) / 16.0)

        if text.endswith((".", "!", "?", "。", "！", "？")):
            score += 0.5

        if score > best_score:
            best_score = score
            best = {
                "index": index,
                "start": start,
                "duration": duration,
                "text": text
            }

    return best


def prepare_global_reference_audio(
    *,
    video_path,
    work_dir,
    segments,
    ref_audio_override,
    ffmpeg,
    librosa,
    sf
):
    if ref_audio_override and os.path.exists(ref_audio_override):
        return ref_audio_override, False, {"mode": "explicit"}

    candidate = _select_reference_candidate(segments)
    if not candidate:
        return None, False, None

    output_audio = os.path.join(work_dir, "global_ref_seed.wav")
    ref_path, should_delete_ref, _ = _extract_reference_audio(
        video_path=video_path,
        ref_audio_override=None,
        output_audio=output_audio,
        start_time=candidate["start"],
        duration=max(candidate["duration"], 1.2),
        ffmpeg=ffmpeg,
        librosa=librosa,
        sf=sf
    )
    return ref_path, should_delete_ref, candidate


def handle_prepare_reference_audio(
    args,
    *,
    ffmpeg,
    librosa,
    sf
):
    if not (args.input and args.ref and args.output):
        return {"success": False, "error": "Usage: --action prepare_reference_audio --input video.mp4 --ref segments.json --output work_dir"}, False

    try:
        with open(args.ref, "r", encoding="utf-8") as f:
            segments = json.load(f)

        if not isinstance(segments, list) or not segments:
            return {"success": False, "error": "No valid segments provided for global reference selection"}, False

        os.makedirs(args.output, exist_ok=True)
        ref_path, _, meta = prepare_global_reference_audio(
            video_path=args.input,
            work_dir=args.output,
            segments=segments,
            ref_audio_override=args.ref_audio,
            ffmpeg=ffmpeg,
            librosa=librosa,
            sf=sf
        )
        if not ref_path:
            return {"success": False, "error": "Failed to prepare global fallback reference audio"}, False

        return {
            "success": True,
            "ref_audio_path": ref_path,
            "meta": meta or {}
        }, False
    except Exception as e:
        return {"success": False, "error": str(e)}, False


def handle_generate_single_tts(
    args,
    tts_kwargs,
    *,
    get_tts_runner,
    get_audio_duration,
    align_audio,
    ffmpeg,
    librosa,
    sf
):
    tts_service_name = getattr(args, "tts_service", "indextts")
    run_tts_func, _ = get_tts_runner(tts_service_name)
    if not run_tts_func:
        result_data = {"success": False, "error": f"Failed to init TTS: {tts_service_name}"}
        if not args.json:
            print(result_data)
        return result_data, False

    if args.input == "dummy":
        if args.json:
            print(json.dumps({"success": True, "message": "Service initialized"}))
        return None, True

    if not (args.input and args.output):
        print("Usage: --action generate_single_tts --input video.mp4 --output segment.wav --text 'Hello' --start 0.5 --duration 2.5 --lang English")
        return None, False

    try:
        video_path = args.input
        output_audio = args.output
        text = getattr(args, "text", None)
        start_time = getattr(args, "start", 0.0)
        duration = args.duration if args.duration else 3.0
        target_lang = args.lang if args.lang else "English"
        voice_mode = str(tts_kwargs.get("voice_mode") or "clone").strip().lower()
        is_narration_mode = voice_mode == "narration"

        if not text:
            return {"success": False, "error": "Missing --text argument"}, False

        try:
            if voice_mode == "narration" and getattr(args, "fallback_ref_audio", None) and os.path.exists(args.fallback_ref_audio):
                ref_clip_path = args.fallback_ref_audio
                should_delete_ref = False
                ref_meta = {"mode": "shared_fallback", "too_short": False}
                print("[SingleTTS] Narration mode: using shared fallback reference audio.")
            else:
                ref_clip_path, should_delete_ref, ref_meta = _extract_reference_audio(
                    video_path=video_path,
                    ref_audio_override=args.ref_audio,
                    output_audio=output_audio,
                    start_time=start_time,
                    duration=duration,
                    ffmpeg=ffmpeg,
                    librosa=librosa,
                    sf=sf
                )
        except Exception as e:
            result_data = {"success": False, "error": f"Failed to extract ref audio: {str(e)}"}
            if args.json:
                print(json.dumps(result_data))
            return result_data, True

        translated_text = text
        if not translated_text:
            return {"success": False, "error": "No text provided"}, False

        if tts_service_name == "qwen" and not tts_kwargs.get("qwen_ref_text"):
            tts_kwargs = dict(tts_kwargs)
            tts_kwargs["qwen_ref_text"] = getattr(args, "qwen_ref_text", "") or ""

        fallback_ref_audio = getattr(args, "fallback_ref_audio", None)
        fallback_ref_text = getattr(args, "fallback_ref_text", "") or ""
        nearby_ref_audios = _parse_nearby_ref_audios(getattr(args, "nearby_ref_audios", None))
        if is_narration_mode:
            nearby_ref_audios = []
        max_retry_attempts = int(getattr(args, "dub_retry_attempts", 3) or 3)
        success = False
        last_error = None
        use_segment_reference = not bool(ref_meta and ref_meta.get("too_short"))
        effective_segment_ref_text = getattr(args, "qwen_ref_text", "") or ""

        if tts_service_name == "qwen" and is_narration_mode:
            if getattr(args, "ref_audio", None) and os.path.exists(getattr(args, "ref_audio", None) or ""):
                effective_segment_ref_text = str(tts_kwargs.get("qwen_ref_text") or "")
            elif fallback_ref_audio and os.path.exists(fallback_ref_audio):
                effective_segment_ref_text = str(fallback_ref_text or "")
            else:
                effective_segment_ref_text = ""

        if not use_segment_reference:
            print("[SingleTTS] Segment reference too short after trim, skipping direct clone reference.")

        if use_segment_reference:
            for attempt in range(1, max_retry_attempts + 1):
                try:
                    print(f"[SingleTTS] Attempt {attempt}/{max_retry_attempts} with segment reference...")
                    attempt_kwargs = _build_retry_tts_kwargs(
                        tts_kwargs,
                        tts_service_name=tts_service_name,
                        attempt=attempt,
                        use_fallback_reference=False
                    )
                    attempt_kwargs = _with_qwen_reference_text(
                        attempt_kwargs,
                        tts_service_name,
                        effective_segment_ref_text
                    )
                    success = run_tts_func(translated_text, ref_clip_path, output_audio, language=target_lang, **attempt_kwargs)
                    if success:
                        last_error = None
                        break
                    last_error = "TTS runner returned False"
                except Exception as attempt_error:
                    last_error = str(attempt_error)
                    print(f"[SingleTTS] Segment reference attempt failed: {attempt_error}")
                    success = False

        if not success and nearby_ref_audios:
            nearby_ref_audios = nearby_ref_audios[:2]
            for nearby_idx, nearby_ref in enumerate(nearby_ref_audios, start=1):
                try:
                    print(f"[SingleTTS] Trying nearby successful reference {nearby_idx}/{len(nearby_ref_audios)}...")
                    nearby_kwargs = _build_retry_tts_kwargs(
                        tts_kwargs,
                        tts_service_name=tts_service_name,
                        attempt=max_retry_attempts + nearby_idx,
                        use_fallback_reference=True
                    )
                    nearby_kwargs = _with_qwen_reference_text(
                        nearby_kwargs,
                        tts_service_name,
                        nearby_ref.get("ref_text", "")
                    )
                    success = run_tts_func(
                        translated_text,
                        nearby_ref.get("audio_path"),
                        output_audio,
                        language=target_lang,
                        **nearby_kwargs
                    )
                    if success:
                        last_error = None
                        break
                    last_error = "Nearby fallback TTS runner returned False"
                except Exception as nearby_error:
                    last_error = str(nearby_error)
                    print(f"[SingleTTS] Nearby successful reference failed: {nearby_error}")
                    success = False

        if not success and fallback_ref_audio and os.path.exists(fallback_ref_audio):
            try:
                print("[SingleTTS] Switching to shared fallback reference audio...")
                fallback_kwargs = _build_retry_tts_kwargs(
                    tts_kwargs,
                    tts_service_name=tts_service_name,
                    attempt=max_retry_attempts + 1,
                    use_fallback_reference=True
                )
                fallback_kwargs = _with_qwen_reference_text(
                    fallback_kwargs,
                    tts_service_name,
                    fallback_ref_text
                )
                success = run_tts_func(translated_text, fallback_ref_audio, output_audio, language=target_lang, **fallback_kwargs)
                if success:
                    last_error = None
                else:
                    last_error = "Fallback TTS runner returned False"
            except Exception as fallback_error:
                last_error = str(fallback_error)
                print(f"[SingleTTS] Shared fallback reference failed: {fallback_error}")
                success = False

        try:
            if should_delete_ref and os.path.exists(ref_clip_path):
                os.remove(ref_clip_path)
        except Exception:
            pass

        if success:
            if duration > 0:
                try:
                    current_dur = get_audio_duration(output_audio)
                    if current_dur and current_dur > duration + 0.1:
                        strategy = getattr(args, "strategy", "auto_speedup")
                        if strategy in ["frame_blend", "freeze_frame", "rife"]:
                            print(f"[SingleTTS] Duration {current_dur:.2f}s > {duration:.2f}s. Strategy {strategy}, skipping alignment.")
                        else:
                            print(f"[SingleTTS] Duration {current_dur:.2f}s > {duration:.2f}s. Aligning...")
                            temp_aligned = output_audio.replace(".wav", "_aligned_temp.wav")
                            if align_audio(output_audio, temp_aligned, duration):
                                shutil.move(temp_aligned, output_audio)
                                print(f"[SingleTTS] Aligned and overwritten: {output_audio}")
                            else:
                                print("[SingleTTS] Alignment failed.")
                except Exception as e:
                    print(f"[SingleTTS] Warning: Auto-alignment failed: {e}")

            final_duration = 0.0
            try:
                final_duration = get_audio_duration(output_audio)
            except Exception:
                pass
            return {"success": True, "audio_path": output_audio, "text": translated_text, "duration": final_duration}, False

        return {"success": False, "error": last_error or "TTS generation failed"}, False
    except Exception as e:
        return {"success": False, "error": str(e)}, False


def handle_generate_batch_tts(
    args,
    tts_kwargs,
    *,
    get_tts_runner,
    get_audio_duration,
    ffmpeg,
    librosa,
    sf
):
    tts_service_name = getattr(args, "tts_service", "indextts")
    if not (args.input and args.ref):
        print("Usage: --action generate_batch_tts --input video.mp4 --ref segments.json")
        return None

    try:
        video_path = args.input
        json_path = args.ref

        with open(json_path, "r", encoding="utf-8") as f:
            segments = json.load(f)

        work_dir = os.path.dirname(json_path)
        print(f"Using {tts_service_name} to generate {len(segments)} segments in batch...")
        print(f"\n[Stage 1] Extracting reference audio to {os.path.join(work_dir, '.cache', 'raw')} ...")
        target_lang = args.lang if args.lang else "English"
        batch_runtime_kwargs = dict(tts_kwargs)
        batch_runtime_kwargs["batch_size"] = int(batch_runtime_kwargs.get("batch_size") or args.batch_size or 1)
        return generate_batch_tts_results(
            video_path=video_path,
            segments=segments,
            work_dir=work_dir,
            target_lang=target_lang,
            tts_service_name=tts_service_name,
            tts_kwargs=batch_runtime_kwargs,
            args_ref_audio=args.ref_audio,
            explicit_qwen_ref_text=getattr(args, "qwen_ref_text", "") or "",
            max_retry_attempts=int(getattr(args, "dub_retry_attempts", 3) or 3),
            get_tts_runner=get_tts_runner,
            get_audio_duration=get_audio_duration,
            ffmpeg=ffmpeg,
            librosa=librosa,
            sf=sf,
            progress_completed_offset=int(getattr(args, "resume_completed", 0) or 0),
            progress_total_override=int(getattr(args, "resume_total", 0) or 0),
            log_prefix="[BatchTTS]"
        )
    except Exception as e:
        print(f"Batch TTS Error: {e}")
        traceback.print_exc()
        return {"success": False, "error": str(e)}
