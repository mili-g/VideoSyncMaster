from __future__ import annotations

from vsm.app.contracts import get_backend_command_names
from vsm.app.workflows.action_router import ActionRouter


def build_action_router(
    *,
    args,
    asr_kwargs,
    tts_kwargs,
    extra_kwargs,
    services,
):
    known_actions = get_backend_command_names()
    return ActionRouter(
        pre_dispatch=lambda: services.dispatch_basic_action(
            args,
            asr_kwargs,
            tts_kwargs,
            extra_kwargs,
            get_tts_runner=services.get_tts_runner,
            run_asr=services.run_asr,
            translate_text=services.translate_text,
            align_audio=services.align_audio,
            get_audio_duration=services.get_audio_duration,
            merge_audios_to_video=services.merge_audios_to_video,
            analyze_video=services.analyze_video,
            transcode_video=services.transcode_video,
            dub_video=services.dub_video,
        ),
        known_actions=known_actions,
        commands={
            "generate_single_tts": lambda: services.handle_generate_single_tts(
                args,
                tts_kwargs,
                get_tts_runner=services.get_tts_runner,
                get_audio_duration=services.get_audio_duration,
                align_audio=services.align_audio,
                ffmpeg=services.ffmpeg,
                librosa=services.librosa,
                sf=services.sf,
            )[0],
            "generate_batch_tts": lambda: services.handle_generate_batch_tts(
                args,
                tts_kwargs,
                get_tts_runner=services.get_tts_runner,
                get_audio_duration=services.get_audio_duration,
                ffmpeg=services.ffmpeg,
                librosa=services.librosa,
                sf=services.sf,
            ),
            "prepare_reference_audio": lambda: services.handle_prepare_reference_audio(
                args,
                ffmpeg=services.ffmpeg,
                librosa=services.librosa,
                sf=services.sf,
            )[0],
            "warmup_tts_runtime": lambda: services.warmup_tts_runtime(
                args.tts_service,
                getattr(args, "tts_model_profile", ""),
            ),
            "switch_runtime_profile": lambda: services.switch_runtime_profile(
                getattr(args, "runtime_profile", "auto"),
                tts_service=getattr(args, "tts_service", None),
                asr_service=getattr(args, "asr", None),
            ),
        },
    )
