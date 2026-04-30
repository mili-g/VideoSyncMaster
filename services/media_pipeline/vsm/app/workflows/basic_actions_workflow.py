from typing import Any, Callable

from error_model import error_result, exception_result, make_error
from vsm.app.contracts import build_backend_command_catalog
from vsm.app.workflows.basic_action_handlers import (
    handle_analyze_video_action,
    handle_check_audio_files_action,
    handle_dub_video_action,
    handle_merge_video_action,
    handle_test_align_action,
    handle_test_asr_action,
    handle_test_tts_action,
    handle_transcode_video_action,
    handle_translate_text_action,
)


def _build_asr_failure_result(service: str, error: Exception):
    detail = str(error)
    detail_lower = detail.lower()
    service_key = str(service or "").strip().lower()
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
        return error_result(
            make_error(
                "JIANYING_SIGN_SERVICE_UNAVAILABLE",
                "剪映 API 当前不可用，签名服务异常",
                category="asr",
                stage="asr",
                retryable=True,
                detail=detail,
                suggestion="请稍后重试，或切换到必剪 API（云端）",
            )
        )

    if (
        "model directory not found" in detail_lower
        or "local faster-whisper model not found" in detail_lower
    ):
        return error_result(
            make_error(
                "ASR_MODEL_MISSING",
                f"{service_label} 模型未安装或目录不存在",
                category="asr",
                stage="asr",
                retryable=False,
                detail=detail,
                suggestion="请前往模型中心下载对应 ASR 模型，或切换到已安装的 faster-whisper / Qwen3-ASR / VibeVoice-ASR",
            )
        )

    if "unrecognized model in" in detail_lower or "should have a `model_type` key" in detail_lower:
        return error_result(
            make_error(
                "ASR_MODEL_LAYOUT_INVALID",
                f"{service_label} 模型目录结构不符合当前加载器要求",
                category="asr",
                stage="asr",
                retryable=False,
                detail=detail,
                suggestion="请检查模型目录内容是否完整，或切换到 Qwen3-ASR / faster-whisper；VibeVoice-ASR 需要补专用加载适配",
            )
        )

    if "required faster-whisper binary not found" in detail_lower:
        return error_result(
            make_error(
                "ASR_BINARY_MISSING",
                "faster-whisper 可执行组件缺失",
                category="asr",
                stage="asr",
                retryable=False,
                detail=detail,
                suggestion="请补齐当前项目要求的 faster-whisper CLI 组件，当前构建已不再提供 Python 模式。",
            )
        )

    if "requires a transformers build" in detail_lower:
        return error_result(
            make_error(
                "ASR_RUNTIME_UNSUPPORTED",
                f"{service_label} 运行时依赖不完整",
                category="asr",
                stage="asr",
                retryable=False,
                detail=detail,
                suggestion="请先修复本地 Python 运行环境，确保 transformers 版本支持当前 ASR 引擎，或临时切换到 faster-whisper",
            )
        )

    return exception_result(
        "ASR_FAILED",
        f"{service_label} 识别失败",
        error,
        category="asr",
        stage="asr",
        retryable=True,
        suggestion=(
            "请先检查本地模型完整性、运行时依赖、设备/显存状态与源语言设置，再结合环境诊断页和后端日志定位具体原因。"
            if service_key in {"qwen", "vibevoice-asr", "faster-whisper"}
            else "请检查网络连接、源语言设置，或切换其他 ASR 引擎后重试"
        ),
    )


def dispatch_basic_action(
    args,
    asr_kwargs: dict,
    tts_kwargs: dict,
    extra_kwargs: dict,
    *,
    get_tts_runner: Callable[..., Any],
    run_asr: Callable[..., Any],
    translate_text: Callable[..., Any],
    align_audio: Callable[..., Any],
    get_audio_duration: Callable[..., Any],
    merge_audios_to_video: Callable[..., Any],
    analyze_video: Callable[..., Any],
    transcode_video: Callable[..., Any],
    dub_video: Callable[..., Any],
):
    handlers = build_basic_action_handlers(
        args,
        asr_kwargs=asr_kwargs,
        tts_kwargs=tts_kwargs,
        extra_kwargs=extra_kwargs,
        get_tts_runner=get_tts_runner,
        run_asr=run_asr,
        translate_text=translate_text,
        align_audio=align_audio,
        get_audio_duration=get_audio_duration,
        merge_audios_to_video=merge_audios_to_video,
        analyze_video=analyze_video,
        transcode_video=transcode_video,
        dub_video=dub_video,
    )
    handler = handlers.get(args.action)
    if handler is None:
        return False, None
    return True, handler()


def list_basic_actions() -> list[str]:
    basic_action_names = {
        "analyze_video",
        "check_audio_files",
        "dub_video",
        "merge_video",
        "test_align",
        "test_asr",
        "test_tts",
        "transcode_video",
        "translate_text",
    }
    return sorted(command.name for command in build_backend_command_catalog() if command.name in basic_action_names)


def build_basic_action_handlers(
    args,
    *,
    asr_kwargs: dict[str, Any],
    tts_kwargs: dict[str, Any],
    extra_kwargs: dict[str, Any],
    get_tts_runner: Callable[..., Any],
    run_asr: Callable[..., Any],
    translate_text: Callable[..., Any],
    align_audio: Callable[..., Any],
    get_audio_duration: Callable[..., Any],
    merge_audios_to_video: Callable[..., Any],
    analyze_video: Callable[..., Any],
    transcode_video: Callable[..., Any],
    dub_video: Callable[..., Any],
) -> dict[str, Callable[[], Any]]:
    return {
        "test_asr": lambda: handle_test_asr_action(
            args,
            asr_kwargs,
            extra_kwargs,
            run_asr=run_asr,
            build_asr_failure_result=_build_asr_failure_result,
        ),
        "translate_text": lambda: handle_translate_text_action(
            args,
            extra_kwargs,
            translate_text=translate_text,
        ),
        "test_tts": lambda: handle_test_tts_action(
            args,
            tts_kwargs,
            get_tts_runner=get_tts_runner,
        ),
        "test_align": lambda: handle_test_align_action(
            args,
            align_audio=align_audio,
        ),
        "merge_video": lambda: handle_merge_video_action(
            args,
            align_audio=align_audio,
            get_audio_duration=get_audio_duration,
            merge_audios_to_video=merge_audios_to_video,
        ),
        "analyze_video": lambda: handle_analyze_video_action(
            args,
            analyze_video=analyze_video,
        ),
        "transcode_video": lambda: handle_transcode_video_action(
            args,
            transcode_video=transcode_video,
        ),
        "dub_video": lambda: handle_dub_video_action(
            args,
            asr_kwargs,
            tts_kwargs,
            extra_kwargs,
            dub_video=dub_video,
        ),
        "check_audio_files": lambda: handle_check_audio_files_action(
            args,
            get_audio_duration=get_audio_duration,
        ),
    }
