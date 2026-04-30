from __future__ import annotations

import os
import shutil

from error_model import emit_error_issue, error_result, make_error
from runtime_config import build_dub_video_runtime_config
from tts_action_handlers import generate_batch_tts_results


def _build_dub_segments_dir(config):
    return os.path.join(config.work_dir, f"{config.basename}_segments")


def _prepare_dub_workspace(config):
    os.makedirs(config.output_dir_root, exist_ok=True)
    os.makedirs(config.work_dir, exist_ok=True)

    cache_dir = os.path.join(config.work_dir, ".cache")
    if not os.path.exists(cache_dir):
        os.makedirs(cache_dir)

    segments_dir = _build_dub_segments_dir(config)
    if os.path.exists(segments_dir):
        shutil.rmtree(segments_dir)
    os.makedirs(segments_dir)

    return cache_dir, segments_dir


def _build_asr_backend_error(service, error, *, make_error):
    detail = str(error)
    service_label = {
        "jianying": "剪映 API",
        "bcut": "必剪 API",
        "qwen": "Qwen3 ASR",
        "vibevoice-asr": "VibeVoice-ASR",
        "faster-whisper": "faster-whisper",
    }.get(service, "ASR 服务")

    if service == "jianying" and (
        "asrtools-update.bkfeng.top/sign" in detail
        or "HTTP Request failed" in detail
        or "500 Server Error" in detail
    ):
        return make_error(
            "JIANYING_SIGN_SERVICE_UNAVAILABLE",
            "剪映 API 当前不可用，签名服务异常",
            category="asr",
            stage="asr",
            retryable=True,
            detail=detail,
            suggestion="请稍后重试，或切换到必剪 API（云端）",
        )

    return make_error(
        "ASR_FAILED",
        f"{service_label} 识别失败",
        category="asr",
        stage="asr",
        retryable=True,
        detail=detail,
        suggestion=(
            "请先检查本地模型完整性、运行时依赖、设备/显存状态与源语言设置，再结合环境诊断页和后端日志定位具体原因。"
            if service in {"qwen", "vibevoice-asr", "faster-whisper"}
            else "请检查网络连接、源语言设置，或切换其他 ASR 引擎后重试"
        ),
    )


def _run_dub_asr_stage(config, cache_dir, *, run_asr, log_business, logger, logging, emit_stage, make_error):
    log_business(logger, logging.INFO, "Starting dub ASR stage", event="dub_step", stage="asr")
    emit_stage("dub_video", "asr", "正在识别字幕", stage_label="正在识别字幕")

    try:
        segments = run_asr(
            config.input_path,
            service=config.asr_service,
            output_dir=cache_dir,
            vad_onset=config.vad_onset,
            vad_offset=config.vad_offset,
            language=config.ori_lang,
            splitter_kwargs=config.translation.to_translator_kwargs(),
            **config.asr.to_runner_kwargs(),
        )
    except Exception as error:
        backend_error = _build_asr_backend_error(config.asr_service, error, make_error=make_error)
        emit_error_issue("dub_video", backend_error)
        return error_result(backend_error)

    if not segments:
        backend_error = make_error(
            "ASR_NO_SEGMENTS",
            "识别失败或未检测到有效语音",
            category="asr",
            stage="asr",
            retryable=True,
            suggestion="请调整源语言、VAD 阈值或更换 ASR 引擎后重试",
        )
        emit_error_issue("dub_video", backend_error)
        return error_result(backend_error)
    return segments


def _run_dub_translation_stage(translator, segments, target_lang, *, log_business, logger, logging, emit_stage):
    log_business(logger, logging.INFO, "Starting dub translation stage", event="dub_step", stage="translate", detail=f"segments={len(segments)}")
    emit_stage("dub_video", "translate", f"正在翻译 {len(segments)} 个片段", stage_label="正在翻译字幕")

    source_texts = [seg.get("text", "") for seg in segments]
    translated_texts = translator.translate_batch(source_texts, target_lang)
    if len(translated_texts) != len(source_texts):
        raise RuntimeError(f"Translation batch length mismatch. Expected {len(source_texts)}, got {len(translated_texts)}")

    for idx, translated_text in enumerate(translated_texts):
        if not isinstance(translated_text, str) or not translated_text.strip():
            raise RuntimeError(f"Translation failed for segment {idx + 1}: empty translated text")
    return translated_texts


def _build_dub_tts_tasks(segments, translated_texts):
    tts_tasks = []
    for idx, seg in enumerate(segments):
        original_text = seg["text"]
        start = seg["start"]
        end = seg["end"]
        duration = max(end - start, 0.1)
        translated_text = translated_texts[idx] if idx < len(translated_texts) else original_text
        translated_text = translated_text.strip() if isinstance(translated_text, str) else ""

        print(f"  [{idx + 1}/{len(segments)}] Translating: {original_text}")
        print(f"    -> {translated_text}")

        if not translated_text:
            print("    Skipping (Translation failed)")
            continue

        tts_tasks.append(
            {
                "idx": idx,
                "translated_text": translated_text,
                "start": start,
                "duration": duration,
                "original_seg": seg,
            }
        )
    return tts_tasks


def _build_dub_tts_segments(tts_tasks, segments_dir):
    return [
        {
            "original_index": item["idx"],
            "start": item["start"],
            "end": item["start"] + item["duration"],
            "text": item["translated_text"],
            "source_text": item["original_seg"].get("text", ""),
            "audioPath": os.path.join(segments_dir, f"dub_{item['idx']}.wav"),
        }
        for item in tts_tasks
    ]


def _align_dubbed_segment_if_needed(tts_output_path, duration, strategy, segment_index, *, get_audio_duration, align_audio):
    should_align = strategy not in ["frame_blend", "freeze_frame", "rife"]
    if not should_align:
        print(f"    [DubVideo] Strategy is {strategy}, skipping audio alignment.")
        return

    if duration <= 0 or not tts_output_path:
        return

    try:
        current_dur = get_audio_duration(tts_output_path)
        if current_dur and current_dur > duration + 0.1:
            print(f"    [DubVideo] Segment {segment_index} duration {current_dur:.2f}s > {duration:.2f}s. Aligning...")
            temp_aligned = tts_output_path.replace(".wav", "_aligned_temp.wav")
            if align_audio(tts_output_path, temp_aligned, duration):
                try:
                    if os.path.exists(tts_output_path):
                        os.remove(tts_output_path)
                    os.rename(temp_aligned, tts_output_path)
                    print(f"    [DubVideo] Aligned and overwritten: {tts_output_path}")
                except Exception as error:
                    print(f"    [DubVideo] Failed to overwrite aligned file: {error}")
    except Exception as error:
        print(f"    [DubVideo] Auto-align warning: {error}")


def _collect_dub_tts_results(tts_tasks, batch_tts_result, strategy, *, get_audio_duration, align_audio, make_error):
    new_audio_segments = []
    result_segments = []

    for item in tts_tasks:
        idx = item["idx"]
        start = item["start"]
        duration = item["duration"]
        translated_text = item["translated_text"]
        original_seg = item["original_seg"]
        result = next((segment for segment in batch_tts_result.get("results", []) if segment.get("index") == idx), None)
        tts_output_path = result.get("audio_path") if isinstance(result, dict) else None
        success = bool(result and result.get("success") and tts_output_path and os.path.exists(tts_output_path))
        last_error = result.get("error") if isinstance(result, dict) else None

        if success:
            _align_dubbed_segment_if_needed(
                tts_output_path,
                duration,
                strategy,
                idx,
                get_audio_duration=get_audio_duration,
                align_audio=align_audio,
            )
            new_audio_segments.append({"start": start, "path": tts_output_path, "duration": duration})
            result_segments.append(
                {
                    "index": idx,
                    "start": start,
                    "end": start + duration,
                    "original_text": original_seg.get("text", ""),
                    "text": translated_text,
                    "audio_path": tts_output_path,
                    "duration": duration,
                    "success": True,
                }
            )
            continue

        print(f"    [DubVideo] Segment {idx} failed after retries: {last_error}")
        emit_error_issue(
            "dub_video",
            make_error(
                "TTS_SEGMENT_FAILED",
                f"片段 {idx + 1} 配音失败",
                category="tts",
                stage="tts_generate",
                retryable=True,
                detail=last_error or "TTS generation failed after retries",
                suggestion="请查看完整日志或切换参考音频后重试",
            ),
            level="warn",
            item_index=idx + 1,
            item_total=len(tts_tasks),
        )
        result_segments.append(
            {
                "index": idx,
                "start": start,
                "end": start + duration,
                "original_text": original_seg.get("text", ""),
                "text": translated_text,
                "audio_path": tts_output_path,
                "duration": duration,
                "success": False,
                "error": last_error or "TTS generation failed after retries",
            }
        )

    return new_audio_segments, result_segments


def _merge_dub_video(config, new_audio_segments, *, log_business, logger, logging, emit_stage, merge_audios_to_video):
    log_business(logger, logging.INFO, "Starting dub merge stage", event="dub_step", stage="merge_video", detail=f"segments={len(new_audio_segments)}")
    emit_stage("dub_video", "merge_video", "正在合成视频", stage_label="正在合成视频")
    return merge_audios_to_video(
        config.input_path,
        new_audio_segments,
        config.output_path,
        strategy=config.strategy,
        audio_mix_mode=config.audio_mix_mode,
    )


def run_dub_video_workflow(
    input_path,
    target_lang,
    output_path,
    *,
    asr_service="faster-whisper",
    vad_onset=0.700,
    vad_offset=0.700,
    tts_service="indextts",
    kwargs,
    logger,
    logging,
    log_business,
    emit_stage,
    get_llm_translator_class,
    get_tts_runner,
    run_asr,
    get_audio_duration,
    align_audio,
    merge_audios_to_video,
    ffmpeg,
    librosa,
    sf,
):
    log_business(logger, logging.INFO, "Starting AI dubbing workflow", event="dub_start", stage="bootstrap", detail=f"input={input_path} target={target_lang} asr={asr_service} tts={tts_service}")
    emit_stage("dub_video", "bootstrap", "正在准备配音任务", stage_label="正在准备任务")
    config = build_dub_video_runtime_config(
        input_path=input_path,
        target_lang=target_lang,
        output_path=output_path,
        asr_service=asr_service,
        vad_onset=vad_onset,
        vad_offset=vad_offset,
        tts_service=tts_service,
        kwargs=kwargs,
    )

    cache_dir, segments_dir = _prepare_dub_workspace(config)
    segments = _run_dub_asr_stage(
        config,
        cache_dir,
        run_asr=run_asr,
        log_business=log_business,
        logger=logger,
        logging=logging,
        emit_stage=emit_stage,
        make_error=make_error,
    )
    if isinstance(segments, dict) and segments.get("success") is False:
        return segments
    if not segments:
        return error_result(
            make_error(
                "ASR_NO_SEGMENTS",
                "识别失败或未检测到有效语音",
                category="asr",
                stage="asr",
                retryable=True,
                suggestion="请调整源语言、VAD 阈值或更换 ASR 引擎后重试",
            )
        )

    print(f"DEBUG: Output Path: {config.output_path}")
    print(f"DEBUG: Segments Dir: {segments_dir}")
    print(f"DEBUG: Input Path: {config.input_path}")

    emit_stage("dub_video", "translate_prepare", "正在加载翻译模型", stage_label="正在准备翻译")
    llm_translator = get_llm_translator_class()
    translator = llm_translator(**config.translation.to_translator_kwargs())
    try:
        translated_texts = _run_dub_translation_stage(
            translator,
            segments,
            config.target_lang,
            log_business=log_business,
            logger=logger,
            logging=logging,
            emit_stage=emit_stage,
        )
        tts_tasks = _build_dub_tts_tasks(segments, translated_texts)
    finally:
        print("Translation done. Releasing LLM VRAM...", flush=True)
        translator.cleanup()
        del translator

    emit_stage("dub_video", "tts_prepare", f"正在初始化 {config.tts_service} 配音引擎", stage_label="正在准备配音")
    run_tts_func, _ = get_tts_runner(config.tts_service)
    if not run_tts_func:
        backend_error = make_error(
            "TTS_INIT_FAILED",
            f"初始化 TTS 服务失败: {config.tts_service}",
            category="tts",
            stage="tts_prepare",
            retryable=True,
            suggestion="请检查模型依赖、显卡环境或切换 TTS 引擎",
        )
        emit_error_issue("dub_video", backend_error)
        return error_result(backend_error)

    log_business(logger, logging.INFO, "Starting dub TTS stage", event="dub_step", stage="tts_generate", detail=f"segments={len(tts_tasks)} service={config.tts_service}")
    emit_stage("dub_video", "tts_generate", f"正在生成 {len(tts_tasks)} 条配音", stage_label="正在生成配音")

    tts_segments = _build_dub_tts_segments(tts_tasks, segments_dir)
    batch_tts_result = generate_batch_tts_results(
        video_path=config.input_path,
        segments=tts_segments,
        work_dir=segments_dir,
        target_lang=config.target_lang,
        tts_service_name=config.tts_service,
        tts_kwargs=config.tts.to_runner_kwargs(),
        args_ref_audio=config.tts.ref_audio,
        explicit_qwen_ref_text=config.tts.qwen_ref_text or "",
        max_retry_attempts=config.dub_retry_attempts,
        get_tts_runner=get_tts_runner,
        get_audio_duration=get_audio_duration,
        ffmpeg=ffmpeg,
        librosa=librosa,
        sf=sf,
        log_prefix="[DubVideo]",
    )
    if not batch_tts_result.get("success"):
        return batch_tts_result

    new_audio_segments, result_segments = _collect_dub_tts_results(
        tts_tasks,
        batch_tts_result,
        config.strategy,
        get_audio_duration=get_audio_duration,
        align_audio=align_audio,
        make_error=make_error,
    )

    failed_segments = [seg for seg in result_segments if seg.get("success") is False]
    if failed_segments:
        failed_indexes = [str(seg.get("index")) for seg in failed_segments]
        print(f"[DubVideo] Warning: segments still failed after retries: {', '.join(failed_indexes)}")
        emit_error_issue(
            "dub_video",
            make_error(
                "TTS_PARTIAL_FAILURE",
                f"{len(failed_segments)} 个片段在重试后仍然失败",
                category="tts",
                stage="tts_generate",
                retryable=True,
                detail=", ".join(failed_indexes),
                suggestion="可先导出日志，再对失败片段单独重试",
            ),
            level="warn",
        )
        if not new_audio_segments:
            return {
                **error_result(
                    make_error(
                        "TTS_ALL_SEGMENTS_FAILED",
                        f"全部配音片段在重试后仍失败: {', '.join(failed_indexes)}",
                        category="tts",
                        stage="tts_generate",
                        retryable=True,
                        detail=", ".join(failed_indexes),
                        suggestion="请先检查参考音频、TTS 引擎与显存状态，再重试失败片段",
                    )
                ),
                "failed_segments": failed_segments,
                "segments": result_segments,
            }

    success = _merge_dub_video(
        config,
        new_audio_segments,
        log_business=log_business,
        logger=logger,
        logging=logging,
        emit_stage=emit_stage,
        merge_audios_to_video=merge_audios_to_video,
    )
    if success:
        if cache_dir and os.path.isdir(cache_dir):
            shutil.rmtree(cache_dir, ignore_errors=True)
        if segments_dir and os.path.isdir(segments_dir):
            shutil.rmtree(segments_dir, ignore_errors=True)
        return {
            "success": True,
            "output": config.output_path,
            "segments": result_segments,
            "failed_segments": failed_segments,
            "partial_success": len(failed_segments) > 0,
            "warning": f"Segments failed after retries: {', '.join(str(seg.get('index')) for seg in failed_segments)}" if failed_segments else None,
        }

    backend_error = make_error(
        "MERGE_VIDEO_FAILED",
        "视频合成失败",
        category="merge",
        stage="merge_video",
        retryable=True,
        suggestion="请检查 FFmpeg、输出路径和完整日志",
    )
    emit_error_issue("dub_video", backend_error)
    return error_result(backend_error)
