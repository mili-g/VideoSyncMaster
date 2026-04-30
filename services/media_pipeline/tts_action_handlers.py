import json
import os
import shutil
import traceback
import time
import builtins
import logging
from app_logging import get_logger, log_business, log_debug, log_error, redirect_print
from error_model import emit_error_issue, error_result, exception_result, make_error
from event_protocol import emit_issue, emit_progress, emit_stage
from runtime_config import build_batch_tts_request_config, build_single_tts_request_config
from vsm.app.workflows.tts_reference_workflow import (
    build_batch_tts_tasks as _build_batch_tts_tasks,
    collect_nearby_success_refs as _collect_nearby_success_refs,
    extract_reference_audio as _extract_reference_audio_impl,
    get_effective_retry_attempts as _get_effective_retry_attempts,
    parse_nearby_ref_audios as _parse_nearby_ref_audios,
    with_qwen_reference_text as _with_qwen_reference_text,
)

logger = get_logger("tts.handlers")
_stdout_print = builtins.print
print = redirect_print(logger, default_level=logging.DEBUG)


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


def _extract_reference_audio(*, video_path, ref_audio_override, output_audio, start_time, duration, ffmpeg, librosa, sf):
    return _extract_reference_audio_impl(
        video_path=video_path,
        ref_audio_override=ref_audio_override,
        output_audio=output_audio,
        start_time=start_time,
        duration=duration,
        ffmpeg=ffmpeg,
        librosa=librosa,
        sf=sf,
        log_business=log_business,
        logger=logger,
        logging=logging,
    )


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
    if not run_batch_tts_func:
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
        log_business(logger, logging.WARNING, "No valid batch TTS tasks available", event="tts_batch_empty", stage="tts_generate")
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
        is_narration_mode = voice_mode == "narration"

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
            if voice_mode == "narration" and request.fallback_ref_audio and os.path.exists(request.fallback_ref_audio):
                ref_clip_path = request.fallback_ref_audio
                should_delete_ref = False
                ref_meta = {"mode": "shared_fallback", "too_short": False}
                print("[SingleTTS] Narration mode: using shared fallback reference audio.")
            else:
                ref_clip_path, should_delete_ref, ref_meta = _extract_reference_audio(
                    video_path=video_path,
                    ref_audio_override=request.ref_audio,
                    output_audio=output_audio,
                    start_time=start_time,
                    duration=duration,
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
        if is_narration_mode:
            nearby_ref_audios = []
        max_retry_attempts = request.dub_retry_attempts
        success = False
        last_error = None
        use_segment_reference = not bool(ref_meta and ref_meta.get("too_short"))
        effective_segment_ref_text = request.qwen_ref_text

        if tts_service_name == "qwen" and is_narration_mode:
            if request.ref_audio and os.path.exists(request.ref_audio):
                effective_segment_ref_text = str(request.tts.qwen_ref_text or "")
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
                    print(f"[SingleTTS] Trying nearby successful reference {nearby_idx}/{len(nearby_ref_audios)}...")
                    nearby_kwargs = _build_retry_tts_kwargs(
                        runtime_tts_kwargs,
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
                    runtime_tts_kwargs,
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
                        strategy = request.strategy
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
