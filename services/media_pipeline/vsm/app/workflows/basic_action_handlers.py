from typing import Any, Callable

from vsm.app.use_cases import (
    analyze_video_use_case,
    check_audio_files_use_case,
    dub_video_use_case,
    merge_video_use_case,
    test_align_use_case,
    test_asr_use_case,
    test_tts_use_case,
    transcode_video_use_case,
    translate_text_use_case,
)


def handle_test_asr_action(
    args,
    asr_kwargs: dict[str, Any],
    extra_kwargs: dict[str, Any],
    *,
    run_asr: Callable[..., Any],
    build_asr_failure_result: Callable[[str, Exception], Any],
):
    if args.input:
        effective_language = args.ori_lang or "Auto"
        if not args.json:
            print(f"Testing ASR on {args.input} using {args.asr} (Original Language: {effective_language})", flush=True)
        try:
            segments = test_asr_use_case(
                args.input,
                service=args.asr,
                output_dir=args.output_dir,
                vad_onset=args.vad_onset,
                vad_offset=args.vad_offset,
                language=args.ori_lang,
                asr_kwargs=asr_kwargs,
                extra_kwargs=extra_kwargs,
                run_asr=run_asr,
            )
        except Exception as error:
            return build_asr_failure_result(args.asr, error)
        if args.json:
            return segments
        for seg in segments:
            print(f"[{seg['start']:.2f} -> {seg['end']:.2f}] {seg['text']}")
    else:
        print("Please provide --input to test ASR.")
    return None


def handle_translate_text_action(
    args,
    extra_kwargs: dict[str, Any],
    *,
    translate_text: Callable[..., Any],
):
    if args.input:
        target = args.lang if args.lang else "English"
        result_data = translate_text_use_case(
            args.input,
            target_lang=target,
            extra_kwargs=extra_kwargs,
            translate_text=translate_text,
        )
        if not args.json:
            printable = result_data["text"] if result_data.get("success") is True and "text" in result_data and len(result_data) == 2 else result_data
            print(printable)
        return result_data

    print("Usage: --action translate_text --input 'Text or JSON' --lang 'Chinese'")
    return None


def handle_test_tts_action(
    args,
    tts_kwargs: dict[str, Any],
    *,
    get_tts_runner: Callable[..., Any],
):
    tts_service_name = getattr(args, "tts_service", "indextts")
    run_tts_func, _ = get_tts_runner(tts_service_name)
    if not run_tts_func:
        print(f"Error: Failed to init TTS service {tts_service_name}")
    elif args.input and args.output:
        if not args.json:
            print(f"Testing TTS ({tts_service_name}).")

        target_lang = args.lang if args.lang else "English"
        ref_audio = args.ref if args.ref else None
        runtime_kwargs = tts_kwargs.copy()
        if hasattr(args, "qwen_mode"):
            runtime_kwargs["qwen_mode"] = args.qwen_mode
        if hasattr(args, "voice_instruct"):
            runtime_kwargs["voice_instruct"] = args.voice_instruct

        try:
            result_data = test_tts_use_case(
                args.input,
                output_path=args.output,
                language=target_lang,
                ref_audio=ref_audio,
                runtime_kwargs=runtime_kwargs,
                run_tts_func=run_tts_func,
            )
            if args.json:
                return result_data
        except Exception as error:
            print(f"Error: {error}")
            if args.json:
                return {"success": False, "error": str(error)}
    else:
        print("Usage: --action test_tts --input 'Text' --ref 'ref.wav' --output 'out.wav' --lang 'Japanese'")
    return None


def handle_test_align_action(args, *, align_audio: Callable[..., Any]):
    if args.input and args.output and args.duration:
        if not args.json:
            print("Testing Alignment.")
        result_data = test_align_use_case(
            args.input,
            output_path=args.output,
            duration=args.duration,
            align_audio=align_audio,
        )
        if args.json:
            return result_data
    else:
        print("Usage: --action test_align --input 'in.wav' --output 'out.wav' --duration 5.0")
    return None


def handle_merge_video_action(
    args,
    *,
    align_audio: Callable[..., Any],
    get_audio_duration: Callable[..., Any],
    merge_audios_to_video: Callable[..., Any],
):
    if args.input and args.ref and args.output:
        try:
            result_data = merge_video_use_case(
                args.input,
                json_path=args.ref,
                output_path=args.output,
                strategy=args.strategy,
                audio_mix_mode=args.audio_mix_mode,
                align_audio=align_audio,
                get_audio_duration=get_audio_duration,
                merge_audios_to_video=merge_audios_to_video,
            )
            if not args.json:
                print(f"Merging audio clips into {args.input}")
                for message in result_data["messages"]:
                    print(message)
            if args.json:
                return result_data
        except Exception as error:
            print(f"Error loading JSON or merging: {error}")
            if args.json:
                return {"success": False, "error": str(error)}
    else:
        print("Usage: --action merge_video --input video.mp4 --ref segments.json --output final.mp4")
    return None


def handle_analyze_video_action(args, *, analyze_video: Callable[..., Any]):
    if args.input:
        result_data = analyze_video_use_case(args.input, analyze_video=analyze_video)
        if not args.json:
            print(result_data)
        return result_data
    print("Please provide --input video path")
    return None


def handle_transcode_video_action(args, *, transcode_video: Callable[..., Any]):
    if args.input and args.output:
        result_data = transcode_video_use_case(
            args.input,
            output_path=args.output,
            transcode_video=transcode_video,
        )
        if not args.json:
            print(result_data)
        return result_data
    print("Usage: --action transcode_video --input in.mp4 --output out.mp4")
    return None


def handle_dub_video_action(
    args,
    asr_kwargs: dict[str, Any],
    tts_kwargs: dict[str, Any],
    extra_kwargs: dict[str, Any],
    *,
    dub_video: Callable[..., Any],
):
    if args.input and args.output:
        target = args.lang if args.lang else "English"
        result_data = dub_video_use_case(
            args.input,
            target_lang=target,
            output_path=args.output,
            work_dir=args.work_dir,
            asr_service=args.asr,
            vad_onset=args.vad_onset,
            vad_offset=args.vad_offset,
            tts_service=args.tts_service,
            strategy=args.strategy,
            audio_mix_mode=args.audio_mix_mode,
            ori_lang=args.ori_lang,
            dub_retry_attempts=args.dub_retry_attempts,
            asr_kwargs=asr_kwargs,
            tts_kwargs=tts_kwargs,
            extra_kwargs=extra_kwargs,
            dub_video=dub_video,
        )
        if not args.json:
            print(result_data)
        return result_data
    print("Usage: --action dub_video --input video.mp4 --output dubbed.mp4 --lang 'Chinese'")
    return None


def handle_check_audio_files_action(args, *, get_audio_duration: Callable[..., Any]):
    if args.input:
        return check_audio_files_use_case(args.input, get_audio_duration=get_audio_duration)
    return None
