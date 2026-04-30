from __future__ import annotations

import builtins
import logging
import os
from dataclasses import dataclass
from typing import Any, Callable

from bootstrap.runtime_env import (
    apply_base_environment,
    configure_models_environment,
    configure_stdio_utf8,
    enable_stream_tee,
    enforce_portable_python,
    ensure_portable_ffmpeg,
    initialize_debug_log,
    install_exception_hook,
    patch_subprocess_encoding,
    resolve_models_hub_dir,
    resolve_runtime_context,
    setup_gpu_paths,
)
from infra.logging import get_logger, log_business, log_error, redirect_print


@dataclass(frozen=True)
class RuntimeBootstrapContext:
    logger: Any
    stdout_print: Callable[..., Any]
    debug_print: Callable[..., Any]
    current_dir: str
    app_root: str
    is_prod: bool
    log_file: str
    debug_log: Callable[[str], None]
    models_hub_dir: str
    ffmpeg_bin: str
    ffmpeg_module: Any


def initialize_runtime_bootstrap(current_file: str, argv: list[str]) -> RuntimeBootstrapContext:
    configure_stdio_utf8()
    apply_base_environment()
    patch_subprocess_encoding()

    logger = get_logger("main")
    stdout_print = builtins.print
    debug_print = redirect_print(logger, default_level=logging.DEBUG)

    current_dir, app_root, is_prod = resolve_runtime_context(current_file)
    log_file, debug_log = initialize_debug_log(app_root, is_prod)
    install_exception_hook(debug_log)
    enforce_portable_python(app_root, current_file, logger)
    enable_stream_tee(log_file)

    models_hub_dir = resolve_models_hub_dir(app_root, current_dir, argv, debug_print)
    if not os.path.exists(models_hub_dir):
        log_error(logger, "Model directory not found", event="model_dir_missing", stage="bootstrap", detail=models_hub_dir)
        log_business(logger, logging.WARNING, "Local TTS support models unavailable; API services remain available", event="model_dir_missing", stage="bootstrap")

    log_business(logger, logging.INFO, "Models directory resolved", event="model_dir_ready", stage="bootstrap", detail=models_hub_dir)
    configure_models_environment(models_hub_dir)

    ffmpeg_bin = ensure_portable_ffmpeg(app_root, logger)
    setup_gpu_paths(logger)

    import ffmpeg

    return RuntimeBootstrapContext(
        logger=logger,
        stdout_print=stdout_print,
        debug_print=debug_print,
        current_dir=current_dir,
        app_root=app_root,
        is_prod=is_prod,
        log_file=log_file,
        debug_log=debug_log,
        models_hub_dir=models_hub_dir,
        ffmpeg_bin=ffmpeg_bin,
        ffmpeg_module=ffmpeg,
    )
