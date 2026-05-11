import json
import os
import shutil
import traceback
import time
import builtins
import logging
import types
from app_logging import get_logger, log_business, log_debug, log_error, redirect_print
from error_model import emit_error_issue, error_result, exception_result, make_error
from event_protocol import emit_issue, emit_progress, emit_stage
from gpt_sovits_service import (
    apply_gpt_sovits_profile_defaults as apply_gpt_sovits_profile_defaults,
    resolve_builtin_reference as resolve_builtin_gpt_sovits_reference,
)
from runtime_config import build_batch_tts_request_config, build_single_tts_request_config
from vsm.app.workflows.tts_reference_workflow import (
    build_batch_tts_tasks as _build_batch_tts_tasks,
    collect_nearby_success_refs as _collect_nearby_success_refs,
    extract_reference_audio as _extract_reference_audio_impl,
    get_effective_retry_attempts as _get_effective_retry_attempts,
    parse_nearby_ref_audios as _parse_nearby_ref_audios,
    resolve_reference_transcript as _resolve_reference_transcript,
    with_qwen_reference_text as _with_qwen_reference_text,
)

logger = get_logger("tts.handlers")
_stdout_print = builtins.print
print = redirect_print(logger, default_level=logging.DEBUG)


def _shared_reference_cache_paths(work_dir, tts_service_name):
    normalized_service = str(tts_service_name or "").strip().lower()
    if normalized_service == "gptsovits":
        base_name = "gpt_sovits_shared_ref"
    else:
        base_name = "global_ref_seed"
    return (
        os.path.join(work_dir, f"{base_name}.wav"),
        os.path.join(work_dir, f"{base_name}.meta.json"),
    )


def _is_reference_duration_acceptable(ref_audio_path, tts_service_name, get_audio_duration_func):
    if not ref_audio_path or not os.path.exists(ref_audio_path):
        return False
    normalized_service = str(tts_service_name or "").strip().lower()
    if normalized_service != "gptsovits":
        return True
    try:
        duration = float(get_audio_duration_func(ref_audio_path) or 0.0)
    except Exception:
        return False
    return 3.0 <= duration <= 10.0


def _build_retry_tts_kwargs(base_kwargs, *, tts_service_name, attempt, use_fallback_reference=False):
    adjusted_kwargs = dict(base_kwargs or {})
    if tts_service_name != "indextts":
        if tts_service_name != "gptsovits":
            return adjusted_kwargs

        attempt = max(int(attempt or 1), 1)
        adjusted_kwargs = apply_gpt_sovits_profile_defaults(adjusted_kwargs)
        profile_id = str(adjusted_kwargs.get("tts_model_profile") or "balanced").strip().lower()
        official_fast_mode = bool(adjusted_kwargs.get("gpt_sovits_official_fast_mode", False))
        adjusted_kwargs["batch_size"] = 1
        adjusted_kwargs["gpt_sovits_parallel_infer"] = False
        adjusted_kwargs["gpt_sovits_split_bucket"] = False
        adjusted_kwargs["gpt_sovits_text_split_method"] = "cut0"
        adjusted_kwargs["gpt_sovits_use_cuda_graph"] = bool(
            adjusted_kwargs.get("gpt_sovits_use_cuda_graph", True)
        )
        adjusted_kwargs["gpt_sovits_batch_threshold"] = min(
            float(adjusted_kwargs.get("gpt_sovits_batch_threshold", 0.75) or 0.75),
            0.26 if profile_id == "quality" else (0.30 if use_fallback_reference else 0.40),
        )
        adjusted_kwargs["temperature"] = min(
            float(adjusted_kwargs.get("temperature", 1.0) or 1.0),
            0.74 if profile_id == "quality" else (0.78 if use_fallback_reference else (0.84 if attempt == 1 else 0.80)),
        )
        adjusted_kwargs["top_p"] = min(
            float(adjusted_kwargs.get("top_p", 1.0) or 1.0),
            0.88 if profile_id == "quality" else (0.90 if use_fallback_reference else (0.94 if attempt == 1 else 0.92)),
        )
        adjusted_kwargs["repetition_penalty"] = max(
            float(adjusted_kwargs.get("repetition_penalty", 1.35) or 1.35),
            1.32 if profile_id == "quality" else (1.30 if use_fallback_reference else (1.24 if attempt == 1 else 1.28)),
        )
        adjusted_kwargs["gpt_sovits_sample_steps"] = max(
            int(adjusted_kwargs.get("gpt_sovits_sample_steps", 32) or 32),
            46 if profile_id == "quality" else (42 if use_fallback_reference else (38 if attempt == 1 else 40)),
        )
        if official_fast_mode and profile_id == "fast":
            adjusted_kwargs["gpt_sovits_batch_threshold"] = min(float(adjusted_kwargs.get("gpt_sovits_batch_threshold", 1.2) or 1.2), 0.36 if use_fallback_reference else 0.44)
            adjusted_kwargs["gpt_sovits_sample_steps"] = max(int(adjusted_kwargs.get("gpt_sovits_sample_steps", 28) or 28), 36 if attempt == 1 else 38)
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


def _reference_text_required(tts_service_name):
    normalized_service = str(tts_service_name or "").strip().lower()
    return normalized_service in {"qwen", "gptsovits"}


def _get_explicit_reference_text(request):
    normalized_service = str(request.tts_service_name or "").strip().lower()
    if normalized_service == "gptsovits":
        return str(request.tts.gpt_sovits_prompt_text or "").strip()
    if normalized_service == "qwen":
        return str(request.tts.qwen_ref_text or request.qwen_ref_text or "").strip()
    return ""


def _is_retry_reference_usable(ref_info, *, tts_service_name, get_audio_duration):
    if not isinstance(ref_info, dict):
        return False
    audio_path = str(ref_info.get("audio_path") or "").strip()
    if not audio_path or not os.path.exists(audio_path):
        return False
    if not _is_reference_duration_acceptable(audio_path, tts_service_name, get_audio_duration):
        return False
    if _reference_text_required(tts_service_name) and not str(ref_info.get("ref_text") or "").strip():
        return False
    return True


def _extract_reference_audio(*, video_path, ref_audio_override, output_audio, start_time, duration, ffmpeg, librosa, sf, tts_service_name="indextts"):
    return _extract_reference_audio_impl(
        video_path=video_path,
        ref_audio_override=ref_audio_override,
        output_audio=output_audio,
        start_time=start_time,
        duration=duration,
        ffmpeg=ffmpeg,
        librosa=librosa,
        sf=sf,
        tts_service_name=tts_service_name,
        log_business=log_business,
        logger=logger,
        logging=logging,
    )


def _run_task_via_single_tts_handler(
    *,
    video_path,
    segment,
    task,
    run_tts_func,
    tts_kwargs,
    tts_service_name,
    target_lang,
    max_retry_attempts,
    nearby_success_map,
    get_audio_duration,
    ffmpeg,
    librosa,
    sf,
):
    nearby_ref_audios = _collect_nearby_success_refs(int(task["index"]), nearby_success_map)
    single_args = types.SimpleNamespace(
        input=video_path,
        output=task["output_path"],
        text=str(task.get("text") or ""),
        start=float(task.get("start", segment.get("start", 0.0)) or 0.0),
        duration=float(task.get("duration", max(float(segment.get("end", 0.0)) - float(segment.get("start", 0.0)), 0.1)) or 0.1),
        lang=target_lang,
        tts_service=tts_service_name,
        strategy="auto_speedup",
        dub_retry_attempts=max_retry_attempts,
        ref_audio=task.get("ref_audio_path") or "",
        fallback_ref_audio=task.get("fallback_ref_audio") or "",
        fallback_ref_text=str(task.get("fallback_ref_text") or ""),
        nearby_ref_audios=nearby_ref_audios,
        qwen_ref_text=str(task.get("ref_text") or ""),
        gpt_sovits_prompt_text=str(task.get("ref_text") or ""),
        gpt_sovits_prompt_lang=str(tts_kwargs.get("gpt_sovits_prompt_lang") or ""),
        voice_mode=str(tts_kwargs.get("voice_mode") or "clone"),
        gpt_sovits_official_fast_mode=bool(tts_kwargs.get("gpt_sovits_official_fast_mode", False)),
        json=True,
    )
    result, _ = handle_generate_single_tts(
        single_args,
        tts_kwargs,
        get_tts_runner=lambda _service: (run_tts_func, None),
        get_audio_duration=get_audio_duration,
        align_audio=lambda *_args, **_kwargs: False,
        ffmpeg=ffmpeg,
        librosa=librosa,
        sf=sf,
    )
    return result or error_result(
        make_error(
            "TTS_GENERATE_FAILED",
            "单段配音生成失败",
            category="tts",
            stage="tts_generate",
            retryable=True,
        )
    )


def _run_gptsovits_batch_via_single_path(
    *,
    video_path,
    segments,
    tasks,
    run_tts_func,
    tts_kwargs,
    target_lang,
    max_retry_attempts,
    get_audio_duration,
    log_prefix,
    ffmpeg,
    librosa,
    sf,
    progress_completed_offset=0,
    progress_total_override=0,
):
    final_output_list = []
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

    for i, seg in enumerate(segments):
        final_idx = seg.get("original_index", i)
        task = task_lookup.get(int(final_idx))
        if not task:
            final_output_list.append(
                {
                    "index": final_idx,
                    "success": False,
                    "error": "TTS Task Failed (No task prepared).",
                }
            )
            continue

        task_position = task_position_lookup.get(int(final_idx), min(i + 1, total_task_count) if total_task_count > 0 else i + 1)
        display_task_position = min(progress_completed_offset + task_position, progress_total) if progress_total > 0 else task_position

        retry_result = {
            "index": final_idx,
            "success": False,
            "audio_path": task["output_path"] if os.path.exists(task["output_path"]) else None,
            "error": "GPT-SoVITS single-path synthesis failed.",
        }
        try:
            emit_retry_status(
                display_task_position,
                f"第 {display_task_position}/{progress_total or total_task_count or total_segments} 条生成中",
                detail="调用官方单句合成链路"
            )
            retry_started_at = time.perf_counter()
            retry_result = _run_task_via_single_tts_handler(
                video_path=video_path,
                segment=seg,
                task=task,
                run_tts_func=run_tts_func,
                tts_kwargs=tts_kwargs,
                tts_service_name="gptsovits",
                target_lang=target_lang,
                max_retry_attempts=max_retry_attempts,
                nearby_success_map=nearby_success_map,
                get_audio_duration=get_audio_duration,
                ffmpeg=ffmpeg,
                librosa=librosa,
                sf=sf,
            )
            attempt_elapsed_ms = (time.perf_counter() - retry_started_at) * 1000.0
            retry_attempts += 1
            retry_elapsed_ms += attempt_elapsed_ms
            retry_success = bool(retry_result.get("success") and retry_result.get("audio_path"))
            if retry_success:
                retry_successes += 1
                retry_result["index"] = final_idx
                retry_result["duration"] = float(
                    retry_result.get("duration")
                    or get_audio_duration(retry_result["audio_path"])
                    or task.get("duration")
                    or 0.0
                )
                nearby_success_map[final_idx] = {
                    "audio_path": retry_result["audio_path"],
                    "ref_text": task.get("text", ""),
                    "duration": retry_result["duration"],
                }
                print(f"[RetryTiming] segment={final_idx} mode=official_single total={attempt_elapsed_ms:.0f}ms success=1")
            else:
                retry_failures += 1
                retry_result["success"] = False
                retry_result["audio_path"] = retry_result.get("audio_path") or (task["output_path"] if os.path.exists(task["output_path"]) else None)
                retry_result["error"] = (
                    retry_result.get("error", {}).get("detail")
                    if isinstance(retry_result.get("error"), dict)
                    else retry_result.get("error")
                ) or "Official single-path synthesis failed"
                print(f"[RetryTiming] segment={final_idx} mode=official_single total={attempt_elapsed_ms:.0f}ms success=0")
        except Exception as retry_exc:
            retry_attempts += 1
            retry_failures += 1
            retry_result["error"] = str(retry_exc)
            print(f"{log_prefix} Segment {final_idx} official single-path retry failed: {retry_exc}")

        final_output_list.append(retry_result)

    if retry_attempts > 0:
        print(
            f"[RetryTiming] total attempts={retry_attempts} success={retry_successes} "
            f"fail={retry_failures} total={retry_elapsed_ms:.0f}ms "
            f"avg={retry_elapsed_ms / retry_attempts:.0f}ms"
        )

    return final_output_list


def _finalize_batch_tts_results(
    *,
    video_path,
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
    ffmpeg,
    librosa,
    sf,
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
                        "ref_text": task_lookup.get(final_idx, {}).get("text", ""),
                        "duration": current_dur or target_dur,
                    }

            if (not res["success"] or not res.get("audio_path")) and task and run_tts_func:
                retry_output = task["output_path"]
                retry_success = False
                retry_error = res.get("error") or "Batch TTS failed"

                nearby_refs = [
                    nearby_ref
                    for nearby_ref in _collect_nearby_success_refs(final_idx, nearby_success_map)
                    if _is_retry_reference_usable(
                        nearby_ref,
                        tts_service_name=tts_service_name,
                        get_audio_duration=get_audio_duration,
                    )
                ]
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
                        fallback_ref = {
                            "audio_path": task.get("fallback_ref_audio", ""),
                            "ref_text": task.get("fallback_ref_text", ""),
                        }
                        if not _is_retry_reference_usable(
                            fallback_ref,
                            tts_service_name=tts_service_name,
                            get_audio_duration=get_audio_duration,
                        ):
                            print(f"{log_prefix} Segment {final_idx} shared fallback skipped: reference not usable for {tts_service_name}.")
                        else:
                            log_business(logger, logging.WARNING, "Switching to shared fallback reference audio", event="tts_retry_fallback", stage="tts_generate", detail=f"segment={final_idx}")
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
                        log_business(logger, logging.WARNING, "Missing segment switched to shared fallback reference audio", event="tts_retry_fallback", stage="tts_generate", detail=f"segment={final_idx}")
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
    normalized_tts_service_name = str(tts_service_name or "").strip().lower()
    if not run_tts_func:
        backend_error = make_error(
            "TTS_INIT_FAILED",
            f"初始化 TTS 失败: {tts_service_name}",
            category="tts",
            stage="tts_generate",
            retryable=True,
            suggestion="请检查 TTS 模型依赖或切换引擎后重试"
        )
        emit_error_issue("generate_batch_tts", backend_error)
        return error_result(backend_error)
    if normalized_tts_service_name != "gptsovits" and not run_batch_tts_func:
        backend_error = make_error(
            "TTS_INIT_FAILED",
            f"初始化批量 TTS 失败: {tts_service_name}",
            category="tts",
            stage="tts_generate",
            retryable=True,
            suggestion="请检查 TTS 模型依赖或切换引擎后重试"
        )
        emit_error_issue("generate_batch_tts", backend_error)
        return error_result(backend_error)

    shared_ref_path = None
    shared_ref_should_clean = False
    shared_ref_meta = None
    voice_mode = str(tts_kwargs.get("voice_mode") or "clone").strip().lower()
    official_fast_mode = bool(tts_kwargs.get("gpt_sovits_official_fast_mode", False))
    if normalized_tts_service_name == "gptsovits" and official_fast_mode:
        voice_mode = "narration"
    resolved_args_ref_audio = args_ref_audio
    resolved_explicit_ref_text = explicit_qwen_ref_text
    if normalized_tts_service_name == "gptsovits":
        resolved_args_ref_audio, resolved_explicit_ref_text, resolved_prompt_lang = resolve_builtin_gpt_sovits_reference(
            args_ref_audio,
            explicit_qwen_ref_text,
            tts_kwargs.get("gpt_sovits_prompt_lang"),
        )
        if resolved_prompt_lang:
            tts_kwargs = dict(tts_kwargs)
            tts_kwargs["gpt_sovits_prompt_lang"] = resolved_prompt_lang

    if not (resolved_args_ref_audio and os.path.exists(resolved_args_ref_audio)):
        try:
            shared_ref_path, shared_ref_should_clean, shared_ref_meta = prepare_global_reference_audio(
                video_path=video_path,
                work_dir=work_dir,
                segments=segments,
                ref_audio_override=resolved_args_ref_audio,
                tts_service_name=tts_service_name,
                ffmpeg=ffmpeg,
                librosa=librosa,
                sf=sf
            )
        except Exception as shared_ref_error:
            print(f"{log_prefix} Failed to prepare shared fallback reference audio: {shared_ref_error}")
            emit_error_issue(
                "generate_batch_tts",
                make_error(
                    "REFERENCE_PREPARE_FAILED",
                    "共享兜底参考音频准备失败",
                    category="reference_audio",
                    stage="prepare_reference",
                    retryable=True,
                    detail=str(shared_ref_error),
                    suggestion="系统将继续执行，但部分片段重试能力可能下降"
                ),
                level="warn"
            )
            shared_ref_path = None
            shared_ref_should_clean = False

    tasks = _build_batch_tts_tasks(
        video_path=video_path,
        segments=segments,
        work_dir=work_dir,
        args_ref_audio=resolved_args_ref_audio,
        voice_mode=voice_mode,
        official_fast_mode=official_fast_mode,
        explicit_qwen_ref_text=resolved_explicit_ref_text,
        shared_ref_path=shared_ref_path,
        shared_ref_meta=shared_ref_meta,
        tts_service_name=tts_service_name,
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
        log_business(logger, logging.WARNING, "No valid batch TTS tasks available", event="tts_batch_empty", stage="tts_generate")
        return {"success": True, "results": []}

    if normalized_tts_service_name == "gptsovits":
        print(
            f"{log_prefix} GPT-SoVITS single-path mode: routing all {len(tasks)} segments "
            f"through official single-sentence synthesis."
        )
        final_output_list = _run_gptsovits_batch_via_single_path(
            video_path=video_path,
            segments=segments,
            tasks=tasks,
            run_tts_func=run_tts_func,
            tts_kwargs=tts_kwargs,
            target_lang=target_lang,
            max_retry_attempts=max_retry_attempts,
            get_audio_duration=get_audio_duration,
            log_prefix=log_prefix,
            ffmpeg=ffmpeg,
            librosa=librosa,
            sf=sf,
            progress_completed_offset=progress_completed_offset,
            progress_total_override=progress_total_override,
        )
        return {"success": True, "results": final_output_list}

    batch_runtime_kwargs = dict(tts_kwargs)
    batch_runtime_kwargs["batch_size"] = int(batch_runtime_kwargs.get("batch_size") or 1)
    batch_runtime_kwargs["progress_completed_offset"] = progress_completed_offset
    batch_runtime_kwargs["progress_total_override"] = progress_total_override
    batch_results = list(run_batch_tts_func(tasks, language=target_lang, **batch_runtime_kwargs))

    final_output_list = _finalize_batch_tts_results(
        video_path=video_path,
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
        ffmpeg=ffmpeg,
        librosa=librosa,
        sf=sf,
        progress_completed_offset=progress_completed_offset,
        progress_total_override=progress_total_override
    )

    return {"success": True, "results": final_output_list}


def _select_reference_candidate(segments):
    ranked = []

    for index, seg in enumerate(segments):
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", start))
        duration = max(0.0, end - start)
        text = _resolve_reference_transcript(seg)
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

        ranked.append(
            {
                "index": index,
                "start": start,
                "duration": duration,
                "text": text,
                "base_score": score,
            }
        )

    ranked.sort(key=lambda item: item["base_score"], reverse=True)
    return ranked


def _score_reference_audio_candidate(
    *,
    video_path,
    work_dir,
    candidate,
    ffmpeg,
    librosa,
    get_audio_duration,
    tts_service_name,
):
    probe_dir = os.path.join(work_dir, ".cache", "shared_ref_probe")
    os.makedirs(probe_dir, exist_ok=True)
    probe_path = os.path.join(probe_dir, f"candidate_{candidate['index']}.wav")
    start_time = float(candidate.get("start", 0.0))
    duration = max(float(candidate.get("duration", 0.0)), 0.1)
    min_duration = 3.0 if str(tts_service_name or "").strip().lower() == "gptsovits" else 2.0
    max_duration = 10.0 if str(tts_service_name or "").strip().lower() == "gptsovits" else None
    extract_duration = max(duration, min_duration)
    if max_duration is not None:
        extract_duration = min(extract_duration, max_duration)

    stream = ffmpeg.input(video_path, ss=start_time, t=extract_duration).output(
        probe_path, acodec="pcm_s16le", ac=1, ar=24000, loglevel="error"
    )
    from ffmpeg_utils import run_ffmpeg
    run_ffmpeg(stream, overwrite_output=True)

    y, sr = librosa.load(probe_path, sr=None)
    if sr is None:
        return float("-inf")
    sample_count = len(y)
    if sample_count == 0:
        return float("-inf")
    trimmed, _ = librosa.effects.trim(y, top_db=20)
    trimmed_duration = len(trimmed) / sr if sr else 0.0
    audio_duration = float(get_audio_duration(probe_path) or extract_duration)
    rms = sum((float(sample) ** 2 for sample in y)) / sample_count
    rms = rms ** 0.5
    peak = max(abs(float(sample)) for sample in y)
    non_silent_ratio = min(1.0, trimmed_duration / audio_duration) if audio_duration > 0 else 0.0

    score = float(candidate.get("base_score", 0.0))
    if min_duration <= trimmed_duration <= (max_duration or trimmed_duration + 1.0):
        score += 6.0
    else:
        score -= abs(trimmed_duration - min_duration) * 2.5

    score += min(rms * 45.0, 4.0)
    score += min(non_silent_ratio * 3.0, 3.0)

    if peak >= 0.98:
        score -= 1.5
    elif peak >= 0.9:
        score -= 0.5

    return score


def prepare_global_reference_audio(
    *,
    video_path,
    work_dir,
    segments,
    ref_audio_override,
    tts_service_name,
    ffmpeg,
    librosa,
    sf
):
    if ref_audio_override and os.path.exists(ref_audio_override):
        return ref_audio_override, False, {"mode": "explicit"}

    output_audio, output_meta = _shared_reference_cache_paths(work_dir, tts_service_name)
    if os.path.exists(output_audio) and os.path.exists(output_meta):
        try:
            cached_meta = json.loads(open(output_meta, "r", encoding="utf-8").read())
            cached_text = str(cached_meta.get("text") or "").strip()
            if cached_text:
                return output_audio, False, cached_meta
        except Exception:
            pass

    ranked_candidates = _select_reference_candidate(segments)
    if not ranked_candidates:
        return None, False, None

    candidate = ranked_candidates[0]
    probe_limit = 6 if str(tts_service_name or "").strip().lower() == "gptsovits" else 3
    best_score = float("-inf")
    for current in ranked_candidates[:probe_limit]:
        try:
            current_score = _score_reference_audio_candidate(
                video_path=video_path,
                work_dir=work_dir,
                candidate=current,
                ffmpeg=ffmpeg,
                librosa=librosa,
                get_audio_duration=lambda path: sf.info(path).duration if os.path.exists(path) else 0.0,
                tts_service_name=tts_service_name,
            )
            if current_score > best_score:
                best_score = current_score
                candidate = current
        except Exception as candidate_error:
            print(f"[SharedRef] Candidate {current.get('index')} scoring failed: {candidate_error}")

    if not candidate:
        return None, False, None

    ref_path, should_delete_ref, _ = _extract_reference_audio(
        video_path=video_path,
        ref_audio_override=None,
        output_audio=output_audio,
        start_time=candidate["start"],
        duration=max(candidate["duration"], 1.2),
        tts_service_name=tts_service_name,
        ffmpeg=ffmpeg,
        librosa=librosa,
        sf=sf
    )
    candidate_meta = {
        "mode": "auto",
        "index": candidate.get("index"),
        "start": candidate.get("start"),
        "duration": candidate.get("duration"),
        "text": candidate.get("text"),
        "tts_service_name": str(tts_service_name or ""),
    }
    with open(output_meta, "w", encoding="utf-8") as handle:
        json.dump(candidate_meta, handle, ensure_ascii=False, indent=2)
    return ref_path, should_delete_ref, candidate_meta


def handle_prepare_reference_audio(
    args,
    *,
    ffmpeg,
    librosa,
    sf
):
    if not (args.input and args.ref and args.output):
        return error_result(
            make_error(
                "PREPARE_REFERENCE_INVALID_ARGS",
                "prepare_reference_audio 参数不完整",
                category="input",
                stage="prepare_reference",
                retryable=False,
                detail="Usage: --action prepare_reference_audio --input video.mp4 --ref segments.json --output work_dir"
            )
        ), False

    try:
        with open(args.ref, "r", encoding="utf-8") as f:
            segments = json.load(f)

        if not isinstance(segments, list) or not segments:
            return error_result(
                make_error(
                    "PREPARE_REFERENCE_NO_SEGMENTS",
                    "没有可用于生成全局参考音频的有效片段",
                    category="input",
                    stage="prepare_reference",
                    retryable=True
                )
            ), False

        os.makedirs(args.output, exist_ok=True)
        ref_path, _, meta = prepare_global_reference_audio(
            video_path=args.input,
            work_dir=args.output,
            segments=segments,
            ref_audio_override=args.ref_audio,
            tts_service_name=str(getattr(args, "tts_service", "") or "indextts"),
            ffmpeg=ffmpeg,
            librosa=librosa,
            sf=sf
        )
        if not ref_path:
            return error_result(
                make_error(
                    "PREPARE_REFERENCE_FAILED",
                    "全局兜底参考音频生成失败",
                    category="reference_audio",
                    stage="prepare_reference",
                    retryable=True
                )
            ), False

        return {
            "success": True,
            "ref_audio_path": ref_path,
            "meta": meta or {}
        }, False
    except Exception as e:
        return exception_result(
            "PREPARE_REFERENCE_EXCEPTION",
            "全局参考音频准备失败",
            e,
            category="reference_audio",
            stage="prepare_reference",
            retryable=True
        ), False


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
    request = build_single_tts_request_config(args, tts_kwargs)
    runtime_tts_kwargs = request.tts.to_runner_kwargs()
    tts_service_name = request.tts_service_name
    resolved_explicit_ref_audio = request.ref_audio
    if str(tts_service_name or "").strip().lower() == "gptsovits":
        resolved_explicit_ref_audio, resolved_prompt_text, resolved_prompt_lang = resolve_builtin_gpt_sovits_reference(
            request.ref_audio,
            request.tts.gpt_sovits_prompt_text,
            request.tts.gpt_sovits_prompt_lang,
        )
        runtime_tts_kwargs = dict(runtime_tts_kwargs)
        if resolved_prompt_text:
            runtime_tts_kwargs["gpt_sovits_prompt_text"] = resolved_prompt_text
        if resolved_prompt_lang:
            runtime_tts_kwargs["gpt_sovits_prompt_lang"] = resolved_prompt_lang
    run_tts_func, _ = get_tts_runner(tts_service_name)
    if not run_tts_func:
        result_data = error_result(
            make_error(
                "TTS_INIT_FAILED",
                f"初始化 TTS 失败: {tts_service_name}",
                category="tts",
                stage="tts_generate",
                retryable=True
            )
        )
        if not args.json:
            _stdout_print(result_data)
        return result_data, False

    if request.video_path == "dummy":
        if args.json:
            _stdout_print(json.dumps({"success": True, "message": "Service initialized"}))
        return None, True

    if not (request.video_path and request.output_audio):
        _stdout_print("Usage: --action generate_single_tts --input video.mp4 --output segment.wav --text 'Hello' --start 0.5 --duration 2.5 --lang English")
        return None, False

    try:
        video_path = request.video_path
        output_audio = request.output_audio
        text = request.text
        start_time = request.start_time
        duration = request.duration
        target_lang = request.target_lang
        voice_mode = str(request.tts.voice_mode or "clone").strip().lower()
        official_fast_mode = bool(runtime_tts_kwargs.get("gpt_sovits_official_fast_mode", False))
        if str(tts_service_name or "").strip().lower() == "gptsovits" and official_fast_mode:
            voice_mode = "narration"
        is_narration_mode = voice_mode == "narration"
        use_gpt_sovits_shared_primary = (
            str(tts_service_name or "").strip().lower() == "gptsovits"
            and not (resolved_explicit_ref_audio and os.path.exists(resolved_explicit_ref_audio))
            and request.fallback_ref_audio
            and os.path.exists(request.fallback_ref_audio)
            and _is_reference_duration_acceptable(request.fallback_ref_audio, tts_service_name, get_audio_duration)
            and str(request.fallback_ref_text or "").strip()
        )

        if not text:
            return error_result(
                make_error(
                    "TTS_TEXT_MISSING",
                    "缺少待合成文本",
                    category="input",
                    stage="tts_generate",
                    retryable=False
                )
            ), False

        try:
            if use_gpt_sovits_shared_primary:
                ref_clip_path = request.fallback_ref_audio
                should_delete_ref = False
                ref_meta = {"mode": "gptsovits_shared_primary", "too_short": False}
                print("[SingleTTS] GPT-SoVITS mode: using shared character reference as primary source.")
            elif (
                voice_mode == "narration"
                and request.fallback_ref_audio
                and os.path.exists(request.fallback_ref_audio)
                and _is_reference_duration_acceptable(request.fallback_ref_audio, tts_service_name, get_audio_duration)
            ):
                ref_clip_path = request.fallback_ref_audio
                should_delete_ref = False
                ref_meta = {"mode": "shared_fallback", "too_short": False}
                print("[SingleTTS] Narration mode: using shared fallback reference audio.")
            else:
                if voice_mode == "narration" and request.fallback_ref_audio and os.path.exists(request.fallback_ref_audio):
                    print("[SingleTTS] Shared fallback reference audio is outside the allowed duration window for the active TTS engine. Falling back to per-segment extraction.")
                ref_clip_path, should_delete_ref, ref_meta = _extract_reference_audio(
                    video_path=video_path,
                    ref_audio_override=resolved_explicit_ref_audio,
                    output_audio=output_audio,
                    start_time=start_time,
                    duration=duration,
                    tts_service_name=tts_service_name,
                    ffmpeg=ffmpeg,
                    librosa=librosa,
                    sf=sf
                )
        except Exception as e:
            result_data = exception_result(
                "REFERENCE_EXTRACT_FAILED",
                "参考音频提取失败",
                e,
                category="reference_audio",
                stage="prepare_reference",
                retryable=True
            )
            if args.json:
                _stdout_print(json.dumps(result_data))
            return result_data, True

        translated_text = text
        if not translated_text:
            return error_result(
                make_error(
                    "TTS_TEXT_EMPTY",
                    "没有可用于合成的文本",
                    category="input",
                    stage="tts_generate",
                    retryable=False
                )
            ), False

        if tts_service_name == "qwen" and not request.tts.qwen_ref_text:
            runtime_tts_kwargs = dict(runtime_tts_kwargs)
            runtime_tts_kwargs["qwen_ref_text"] = request.qwen_ref_text

        fallback_ref_audio = request.fallback_ref_audio
        fallback_ref_text = request.fallback_ref_text
        nearby_ref_audios = _parse_nearby_ref_audios(request.nearby_ref_audios)
        if is_narration_mode or use_gpt_sovits_shared_primary:
            nearby_ref_audios = []
        max_retry_attempts = (
            max(2, int(request.dub_retry_attempts or 0))
            if (str(tts_service_name or "").strip().lower() == "gptsovits" and official_fast_mode)
            else request.dub_retry_attempts
        )
        success = False
        last_error = None
        use_segment_reference = not bool(ref_meta and ref_meta.get("too_short"))
        explicit_ref_text = _get_explicit_reference_text(request)
        if str(tts_service_name or "").strip().lower() == "gptsovits":
            explicit_ref_text = str(runtime_tts_kwargs.get("gpt_sovits_prompt_text") or explicit_ref_text or "").strip()
        effective_segment_ref_text = str(fallback_ref_text or "").strip() if use_gpt_sovits_shared_primary else explicit_ref_text

        if _reference_text_required(tts_service_name) and is_narration_mode and not use_gpt_sovits_shared_primary:
            if resolved_explicit_ref_audio and os.path.exists(resolved_explicit_ref_audio):
                effective_segment_ref_text = explicit_ref_text
            elif fallback_ref_audio and os.path.exists(fallback_ref_audio):
                effective_segment_ref_text = str(fallback_ref_text or "").strip()
            else:
                effective_segment_ref_text = ""

        if not use_segment_reference:
            print("[SingleTTS] Segment reference too short after trim, skipping direct clone reference.")
        elif _reference_text_required(tts_service_name) and not effective_segment_ref_text:
            print("[SingleTTS] Segment reference text unavailable, skipping direct clone reference.")
            use_segment_reference = False

        primary_attempts = max(1, max_retry_attempts if max_retry_attempts > 0 else 1)
        if use_segment_reference:
            for attempt in range(1, primary_attempts + 1):
                try:
                    print(f"[SingleTTS] Attempt {attempt}/{max_retry_attempts} with segment reference...")
                    attempt_kwargs = _build_retry_tts_kwargs(
                        runtime_tts_kwargs,
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
                    nearby_ref_text = str(nearby_ref.get("ref_text", "") or "").strip()
                    if _reference_text_required(tts_service_name) and not nearby_ref_text:
                        print(f"[SingleTTS] Nearby successful reference {nearby_idx}/{len(nearby_ref_audios)} skipped: missing reference text.")
                        continue
                    print(f"[SingleTTS] Trying nearby successful reference {nearby_idx}/{len(nearby_ref_audios)}...")
                    nearby_kwargs = _build_retry_tts_kwargs(
                        runtime_tts_kwargs,
                        tts_service_name=tts_service_name,
                        attempt=primary_attempts + nearby_idx,
                        use_fallback_reference=True
                    )
                    nearby_kwargs = _with_qwen_reference_text(
                        nearby_kwargs,
                        tts_service_name,
                        nearby_ref_text
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
                if not _is_reference_duration_acceptable(fallback_ref_audio, tts_service_name, get_audio_duration):
                    print("[SingleTTS] Shared fallback reference skipped: duration is outside the active TTS engine window.")
                elif _reference_text_required(tts_service_name) and not str(fallback_ref_text or "").strip():
                    print("[SingleTTS] Shared fallback reference skipped: missing reference text.")
                else:
                    print("[SingleTTS] Switching to shared fallback reference audio...")
                    fallback_kwargs = _build_retry_tts_kwargs(
                        runtime_tts_kwargs,
                        tts_service_name=tts_service_name,
                        attempt=primary_attempts + 1,
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
                        strategy = request.strategy
                        if str(tts_service_name or "").strip().lower() == "gptsovits":
                            print(f"[SingleTTS] Duration {current_dur:.2f}s > {duration:.2f}s. GPT-SoVITS single-path skips per-segment alignment.")
                        elif strategy in ["frame_blend", "freeze_frame", "rife"]:
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

        return error_result(
            make_error(
                "TTS_GENERATE_FAILED",
                "单段配音生成失败",
                category="tts",
                stage="tts_generate",
                retryable=True,
                detail=last_error or "TTS generation failed",
                suggestion="请更换参考音频、切换引擎或稍后重试"
            )
        ), False
    except Exception as e:
        return exception_result(
            "TTS_SINGLE_EXCEPTION",
            "单段配音执行异常",
            e,
            category="tts",
            stage="tts_generate",
            retryable=True
        ), False


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
    request = build_batch_tts_request_config(args, tts_kwargs)
    tts_service_name = request.tts_service_name
    if not (request.video_path and request.json_path):
        _stdout_print("Usage: --action generate_batch_tts --input video.mp4 --ref segments.json")
        return None

    try:
        video_path = request.video_path
        json_path = request.json_path

        with open(json_path, "r", encoding="utf-8") as f:
            segments = json.load(f)

        work_dir = request.work_dir
        print(f"Using {tts_service_name} to generate {len(segments)} segments in batch...")
        print(f"\n[Stage 1] Extracting reference audio to {os.path.join(work_dir, '.cache', 'raw')} ...")
        target_lang = request.target_lang
        batch_runtime_kwargs = request.tts.to_runner_kwargs()
        batch_runtime_kwargs["batch_size"] = max(1, int(batch_runtime_kwargs.get("batch_size") or 1))
        return generate_batch_tts_results(
            video_path=video_path,
            segments=segments,
            work_dir=work_dir,
            target_lang=target_lang,
            tts_service_name=tts_service_name,
            tts_kwargs=batch_runtime_kwargs,
            args_ref_audio=request.args_ref_audio,
            explicit_qwen_ref_text=request.explicit_qwen_ref_text,
            max_retry_attempts=request.max_retry_attempts,
            get_tts_runner=get_tts_runner,
            get_audio_duration=get_audio_duration,
            ffmpeg=ffmpeg,
            librosa=librosa,
            sf=sf,
            progress_completed_offset=request.progress_completed_offset,
            progress_total_override=request.progress_total_override,
            log_prefix="[BatchTTS]"
        )
    except Exception as e:
        log_error(logger, "Batch TTS execution exception", event="tts_batch_exception", stage="tts_generate", detail=str(e), code="TTS_BATCH_EXCEPTION")
        traceback.print_exc()
        return exception_result(
            "TTS_BATCH_EXCEPTION",
            "批量配音执行异常",
            e,
            category="tts",
            stage="tts_generate",
            retryable=True
        )
