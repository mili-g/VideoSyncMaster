from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any


PROFILE_INDEX_TTS = "4.57.6"
PROFILE_QWEN3 = "4.57.6"

_run_tts = None
_run_batch_tts = None
_loaded_tts_service = None


def get_tts_runner(
    service: str,
    *,
    check_deps: bool,
    logger,
    setup_gpu_paths: Callable[[Any], None],
    ensure_transformers_version: Callable[[str], bool],
    check_gpu_deps: Callable[[], None],
    log_business: Callable[..., None],
    log_error: Callable[..., None],
):
    global _run_tts, _run_batch_tts, _loaded_tts_service

    if _loaded_tts_service == service and _run_tts and _run_batch_tts:
        return _run_tts, _run_batch_tts

    if check_deps:
        if service == "qwen":
            log_business(logger, logging.INFO, "Ensuring dependencies for Qwen3-TTS", event="deps_check", stage="bootstrap")
            setup_gpu_paths(logger)
            if ensure_transformers_version(PROFILE_QWEN3):
                check_gpu_deps()
                log_business(logger, logging.INFO, "Qwen3 dependencies ready", event="deps_ready", stage="bootstrap")
            else:
                log_error(logger, "Failed to setup Qwen3 dependencies", event="deps_failed", stage="bootstrap", code="QWEN_DEPS_FAILED")
                return None, None
        else:
            log_business(logger, logging.INFO, "Ensuring dependencies for IndexTTS", event="deps_check", stage="bootstrap")
            if ensure_transformers_version(PROFILE_INDEX_TTS):
                log_business(logger, logging.INFO, "IndexTTS dependencies ready", event="deps_ready", stage="bootstrap")
            else:
                log_error(logger, "Failed to setup IndexTTS dependencies", event="deps_failed", stage="bootstrap", code="INDEXTTS_DEPS_FAILED")
                return None, None

    try:
        if service == "qwen":
            from qwen_tts_service import get_qwen_tts_runtime_status, run_batch_qwen_tts, run_qwen_tts

            available, detail = get_qwen_tts_runtime_status()
            if not available:
                log_error(logger, f"Qwen3-TTS runtime unavailable: {detail}", event="tts_import_failed", stage="bootstrap", code="QWEN_TTS_RUNTIME_UNAVAILABLE")
                return None, None

            _run_tts, _run_batch_tts = run_qwen_tts, run_batch_qwen_tts
        else:
            from tts import get_indextts_runtime_status, run_batch_tts, run_tts

            available, detail = get_indextts_runtime_status()
            if not available:
                log_error(logger, f"IndexTTS runtime unavailable: {detail}", event="tts_import_failed", stage="bootstrap", code="INDEXTTS_RUNTIME_UNAVAILABLE")
                return None, None

            _run_tts, _run_batch_tts = run_tts, run_batch_tts
        _loaded_tts_service = service
        return _run_tts, _run_batch_tts
    except ImportError as error:
        log_error(logger, f"Failed to import TTS service {service}", event="tts_import_failed", stage="bootstrap", detail=str(error))
        return None, None


def warmup_tts_runtime(
    service: str,
    model_profile: str,
    *,
    get_tts_runner: Callable[..., tuple[Any, Any]],
    get_installed_version: Callable[[str], str | None],
    log_business: Callable[..., None],
    emit_stage: Callable[..., None],
    emit_error_issue: Callable[..., None],
    error_result: Callable[[Any], dict[str, Any]],
    make_error: Callable[..., Any],
    logger,
):
    log_business(
        logger,
        logging.INFO,
        "Warming up TTS runtime",
        event="tts_runtime_warmup",
        stage="bootstrap",
        detail=f"{service}:{model_profile or 'default'}",
    )
    emit_stage(
        "warmup_tts_runtime",
        "bootstrap",
        f"正在准备 {service} 运行环境",
        stage_label="正在切换 TTS 环境",
    )

    run_tts_func, run_batch_tts_func = get_tts_runner(service)
    if not run_tts_func or not run_batch_tts_func:
        backend_error = make_error(
            "TTS_RUNTIME_WARMUP_FAILED",
            f"TTS 运行环境准备失败: {service}",
            category="tts",
            stage="bootstrap",
            retryable=True,
            detail=f"runner_init_failed:{service}",
            suggestion="请检查模型依赖、Python 运行环境或切换缓存",
        )
        emit_error_issue("warmup_tts_runtime", backend_error)
        return error_result(backend_error)

    emit_stage(
        "warmup_tts_runtime",
        "bootstrap",
        f"{service} 运行环境已就绪",
        status="completed",
        stage_label="正在切换 TTS 环境",
    )
    return {
        "success": True,
        "service": service,
        "model_profile": model_profile or "default",
        "runtime_version": get_installed_version("transformers"),
    }
