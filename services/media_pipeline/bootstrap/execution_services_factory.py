from __future__ import annotations

import logging as logging_module
from dataclasses import dataclass
from typing import Any, Callable

from vsm.app.services import ExecutionServices


class LazyModuleProxy:
    def __init__(self, resolver: Callable[[], Any]) -> None:
        self._resolver = resolver

    def __getattr__(self, name: str) -> Any:
        return getattr(self._resolver(), name)


@dataclass(frozen=True)
class ExecutionRuntimeDependencies:
    logger: Any
    logging_module: Any
    ffmpeg_module: Any
    setup_gpu_paths: Callable[[Any], None]


@dataclass(frozen=True)
class RuntimeProfileDependencies:
    resolve_tts_runner: Callable[..., Any]
    run_tts_runtime_warmup: Callable[..., Any]
    ensure_transformers_version: Callable[[str], bool]
    check_gpu_deps: Callable[[], None]
    get_installed_version: Callable[[str], str | None]
    infer_runtime_profile: Callable[..., str]
    normalize_runtime_profile: Callable[[str | None], str]
    resolve_runtime_profile_version: Callable[[str | None], str | None]


@dataclass(frozen=True)
class ExecutionObservabilityDependencies:
    log_business: Callable[..., Any]
    log_error: Callable[..., Any]
    emit_stage: Callable[..., Any]
    emit_error_issue: Callable[..., Any]
    error_result: Callable[..., Any]
    make_error: Callable[..., Any]
    exception_result: Callable[..., Any]
    emit_progress: Callable[..., Any]
    emit_partial_result: Callable[..., Any]


@dataclass(frozen=True)
class ExecutionServiceFactoryContext:
    runtime: ExecutionRuntimeDependencies
    runtime_profiles: RuntimeProfileDependencies
    observability: ExecutionObservabilityDependencies


def build_execution_services(context: ExecutionServiceFactoryContext) -> ExecutionServices:
    lazy_state: dict[str, Any] = {
        "basic_action_handlers": None,
        "llm_translator_class": None,
        "asr_runner": None,
        "alignment_module": None,
        "librosa_module": None,
        "soundfile_module": None,
        "translation_workflow": None,
        "media_workflows": None,
        "dub_video_workflow": None,
        "tts_action_handlers": None,
    }

    def get_basic_action_handlers():
        if lazy_state["basic_action_handlers"] is None:
            from action_handlers import dispatch_basic_action, list_basic_actions

            lazy_state["basic_action_handlers"] = (dispatch_basic_action, list_basic_actions)
        return lazy_state["basic_action_handlers"]

    def get_llm_translator_class():
        if lazy_state["llm_translator_class"] is None:
            from llm import LLMTranslator

            lazy_state["llm_translator_class"] = LLMTranslator
        return lazy_state["llm_translator_class"]

    def get_asr_runner():
        if lazy_state["asr_runner"] is None:
            from asr import run_asr as imported_run_asr

            lazy_state["asr_runner"] = imported_run_asr
        return lazy_state["asr_runner"]

    def get_alignment_module():
        if lazy_state["alignment_module"] is None:
            import alignment as imported_alignment

            lazy_state["alignment_module"] = imported_alignment
        return lazy_state["alignment_module"]

    def get_audio_runtime_modules():
        if lazy_state["librosa_module"] is None or lazy_state["soundfile_module"] is None:
            import librosa as imported_librosa
            import soundfile as imported_soundfile

            lazy_state["librosa_module"] = imported_librosa
            lazy_state["soundfile_module"] = imported_soundfile
        return lazy_state["librosa_module"], lazy_state["soundfile_module"]

    def get_librosa_module():
        return get_audio_runtime_modules()[0]

    def get_soundfile_module():
        return get_audio_runtime_modules()[1]

    def get_translation_workflow():
        if lazy_state["translation_workflow"] is None:
            from vsm.app.workflows.translation_workflow import translate_text_workflow as imported_translate_text_workflow

            lazy_state["translation_workflow"] = imported_translate_text_workflow
        return lazy_state["translation_workflow"]

    def get_media_workflows():
        if lazy_state["media_workflows"] is None:
            from vsm.app.workflows.media_workflow import (
                analyze_video_workflow as imported_analyze_video_workflow,
                transcode_video_workflow as imported_transcode_video_workflow,
            )

            lazy_state["media_workflows"] = (
                imported_analyze_video_workflow,
                imported_transcode_video_workflow,
            )
        return lazy_state["media_workflows"]

    def get_dub_video_workflow():
        if lazy_state["dub_video_workflow"] is None:
            from vsm.app.workflows.dub_video_workflow import run_dub_video_workflow as imported_run_dub_video_workflow

            lazy_state["dub_video_workflow"] = imported_run_dub_video_workflow
        return lazy_state["dub_video_workflow"]

    def get_tts_action_handlers():
        if lazy_state["tts_action_handlers"] is None:
            from tts_action_handlers import (
                handle_generate_batch_tts as imported_handle_generate_batch_tts,
                handle_generate_single_tts as imported_handle_generate_single_tts,
                handle_prepare_reference_audio as imported_handle_prepare_reference_audio,
            )

            lazy_state["tts_action_handlers"] = (
                imported_handle_generate_single_tts,
                imported_handle_generate_batch_tts,
                imported_handle_prepare_reference_audio,
            )
        return lazy_state["tts_action_handlers"]

    def run_asr(*args, **kwargs):
        return get_asr_runner()(*args, **kwargs)

    def align_audio(*args, **kwargs):
        return get_alignment_module().align_audio(*args, **kwargs)

    def get_audio_duration(*args, **kwargs):
        return get_alignment_module().get_audio_duration(*args, **kwargs)

    def merge_audios_to_video(*args, **kwargs):
        return get_alignment_module().merge_audios_to_video(*args, **kwargs)

    def get_tts_runner(service="indextts", check_deps=True):
        return context.runtime_profiles.resolve_tts_runner(
            service,
            check_deps=check_deps,
            logger=context.runtime.logger,
            setup_gpu_paths=context.runtime.setup_gpu_paths,
            ensure_transformers_version=context.runtime_profiles.ensure_transformers_version,
            check_gpu_deps=context.runtime_profiles.check_gpu_deps,
            log_business=context.observability.log_business,
            log_error=context.observability.log_error,
        )

    def warmup_tts_runtime(service="indextts", model_profile=""):
        return context.runtime_profiles.run_tts_runtime_warmup(
            service,
            model_profile,
            get_tts_runner=get_tts_runner,
            get_installed_version=context.runtime_profiles.get_installed_version,
            log_business=context.observability.log_business,
            emit_stage=context.observability.emit_stage,
            emit_error_issue=context.observability.emit_error_issue,
            error_result=context.observability.error_result,
            make_error=context.observability.make_error,
            logger=context.runtime.logger,
        )

    def switch_runtime_profile(runtime_profile="auto", *, tts_service=None, asr_service=None):
        requested_profile = context.runtime_profiles.infer_runtime_profile(
            tts_service=tts_service,
            asr_service=asr_service,
            requested_profile=runtime_profile,
        )
        target_version = context.runtime_profiles.resolve_runtime_profile_version(requested_profile)
        if target_version is None:
            return {
                "success": True,
                "runtime_profile": context.runtime_profiles.normalize_runtime_profile(requested_profile),
                "runtime_version": context.runtime_profiles.get_installed_version("transformers"),
                "switched": False,
                "message": "当前运行环境无需切换",
            }

        switched = context.runtime_profiles.ensure_transformers_version(target_version)
        return {
            "success": bool(switched),
            "runtime_profile": context.runtime_profiles.normalize_runtime_profile(requested_profile),
            "runtime_version": context.runtime_profiles.get_installed_version("transformers"),
            "target_version": target_version,
            "switched": bool(switched),
            "message": "运行环境已切换" if switched else "运行环境切换失败",
        }

    def analyze_video(file_path):
        analyze_video_workflow, _ = get_media_workflows()
        return analyze_video_workflow(
            file_path,
            ffmpeg=context.runtime.ffmpeg_module,
            exception_result=context.observability.exception_result,
        )

    def transcode_video(input_path, output_path):
        _, transcode_video_workflow = get_media_workflows()
        return transcode_video_workflow(
            input_path,
            output_path,
            ffmpeg=context.runtime.ffmpeg_module,
            logger=context.runtime.logger,
            logging=context.runtime.logging_module,
            log_business=context.observability.log_business,
            log_error=context.observability.log_error,
            error_result=context.observability.error_result,
            exception_result=context.observability.exception_result,
            make_error=context.observability.make_error,
        )

    def translate_text(input_text_or_json, target_lang, **kwargs):
        return get_translation_workflow()(
            input_text_or_json,
            target_lang,
            translator_factory=get_llm_translator_class(),
            exception_result=context.observability.exception_result,
            emit_stage=context.observability.emit_stage,
            emit_progress=context.observability.emit_progress,
            emit_partial_result=context.observability.emit_partial_result,
            **kwargs,
        )

    def dub_video(
        input_path,
        target_lang,
        output_path,
        asr_service="faster-whisper",
        vad_onset=0.700,
        vad_offset=0.700,
        tts_service="indextts",
        **kwargs,
    ):
        librosa, sf = get_audio_runtime_modules()
        return get_dub_video_workflow()(
            input_path=input_path,
            target_lang=target_lang,
            output_path=output_path,
            asr_service=asr_service,
            vad_onset=vad_onset,
            vad_offset=vad_offset,
            tts_service=tts_service,
            kwargs=kwargs,
            logger=context.runtime.logger,
            logging=context.runtime.logging_module,
            log_business=context.observability.log_business,
            emit_stage=context.observability.emit_stage,
            get_llm_translator_class=get_llm_translator_class,
            get_tts_runner=get_tts_runner,
            run_asr=run_asr,
            get_audio_duration=get_audio_duration,
            align_audio=align_audio,
            merge_audios_to_video=merge_audios_to_video,
            ffmpeg=context.runtime.ffmpeg_module,
            librosa=librosa,
            sf=sf,
        )

    def handle_generate_single_tts(*args, **kwargs):
        single_tts_handler, _, _ = get_tts_action_handlers()
        return single_tts_handler(*args, **kwargs)

    def handle_generate_batch_tts(*args, **kwargs):
        _, batch_tts_handler, _ = get_tts_action_handlers()
        return batch_tts_handler(*args, **kwargs)

    def handle_prepare_reference_audio(*args, **kwargs):
        _, _, reference_audio_handler = get_tts_action_handlers()
        return reference_audio_handler(*args, **kwargs)

    return ExecutionServices(
        dispatch_basic_action=lambda *args, **kwargs: get_basic_action_handlers()[0](*args, **kwargs),
        list_basic_actions=lambda: get_basic_action_handlers()[1](),
        get_tts_runner=get_tts_runner,
        run_asr=run_asr,
        translate_text=translate_text,
        align_audio=align_audio,
        get_audio_duration=get_audio_duration,
        merge_audios_to_video=merge_audios_to_video,
        analyze_video=analyze_video,
        transcode_video=transcode_video,
        dub_video=dub_video,
        handle_generate_single_tts=handle_generate_single_tts,
        handle_generate_batch_tts=handle_generate_batch_tts,
        handle_prepare_reference_audio=handle_prepare_reference_audio,
        ffmpeg=context.runtime.ffmpeg_module,
        librosa=LazyModuleProxy(get_librosa_module),
        sf=LazyModuleProxy(get_soundfile_module),
        warmup_tts_runtime=warmup_tts_runtime,
        switch_runtime_profile=switch_runtime_profile,
    )
