import json
import os
from typing import Any, Callable

from error_model import error_result, exception_result, make_error


def _build_asr_failure_result(service: str, error: Exception):
    detail = str(error)
    service_label = {
        "jianying": "剪映 API",
        "bcut": "必剪 API",
        "qwen": "Qwen3 ASR",
        "whisperx": "WhisperX",
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
                suggestion="请稍后重试，或切换到必剪 API（云端）"
            )
        )

    return exception_result(
        "ASR_FAILED",
        f"{service_label} 识别失败",
        error,
        category="asr",
        stage="asr",
        retryable=True,
        suggestion="请检查网络连接、源语言设置，或切换其他 ASR 引擎后重试"
    )


def dispatch_basic_action(
    args,
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
    dub_video: Callable[..., Any]
):
    if args.action == "test_asr":
        if args.input:
            if not args.json:
                print(f"Testing ASR on {args.input} using {args.asr} (Original Language: {args.ori_lang})", flush=True)
            try:
                segments = run_asr(
                    args.input,
                    service=args.asr,
                    output_dir=args.output_dir,
                    vad_onset=args.vad_onset,
                    vad_offset=args.vad_offset,
                    language=args.ori_lang
                )
            except Exception as error:
                return True, _build_asr_failure_result(args.asr, error)
            if args.json:
                return True, segments
            for seg in segments:
                print(f"[{seg['start']:.2f} -> {seg['end']:.2f}] {seg['text']}")
        else:
            print("Please provide --input to test ASR.")
        return True, None

    if args.action == "translate_text":
        if args.input:
            target = args.lang if args.lang else "English"
            result_raw = translate_text(args.input, target, **extra_kwargs)

            if isinstance(result_raw, dict):
                result_data = result_raw
            else:
                result_data = {"success": True, "text": result_raw}

            if not args.json:
                print(result_raw)
            return True, result_data

        print("Usage: --action translate_text --input 'Text or JSON' --lang 'Chinese'")
        return True, None

    if args.action == "test_tts":
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
                success = run_tts_func(args.input, ref_audio, args.output, language=target_lang, **runtime_kwargs)
                if args.json:
                    return True, {"success": success, "output": args.output}
            except Exception as e:
                print(f"Error: {e}")
                if args.json:
                    return True, {"success": False, "error": str(e)}
        else:
            print("Usage: --action test_tts --input 'Text' --ref 'ref.wav' --output 'out.wav' --lang 'Japanese'")
        return True, None

    if args.action == "test_align":
        if args.input and args.output and args.duration:
            if not args.json:
                print("Testing Alignment.")
            success = align_audio(args.input, args.output, args.duration)
            if args.json:
                return True, {"success": success, "output": args.output}
        else:
            print("Usage: --action test_align --input 'in.wav' --output 'out.wav' --duration 5.0")
        return True, None

    if args.action == "merge_video":
        if args.input and args.ref and args.output:
            video_path = args.input
            json_path = args.ref
            output_path = args.output

            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    audio_segments = json.load(f)

                if not args.json:
                    print(f"Merging {len(audio_segments)} audio clips into {video_path}")

                for i, seg in enumerate(audio_segments):
                    if "start" in seg and "end" in seg and "path" in seg:
                        target_duration = float(seg["end"]) - float(seg["start"])
                        audio_segments[i]["duration"] = target_duration
                        audio_path = seg["path"]

                        if os.path.exists(audio_path):
                            current_duration = get_audio_duration(audio_path)
                            if current_duration and current_duration > target_duration + 0.1:
                                if args.strategy in ["frame_blend", "freeze_frame", "rife"]:
                                    print(f"Segment {i} exceeds slot, but strategy is {args.strategy}. Skipping audio alignment.")
                                else:
                                    print(f"Segment {i} duration ({current_duration:.2f}s) exceeds slot ({target_duration:.2f}s). Aligning...")
                                    aligned_path = audio_path.replace(".wav", "_aligned.wav")
                                    if align_audio(audio_path, aligned_path, target_duration):
                                        audio_segments[i]["path"] = aligned_path
                                    else:
                                        print(f"Failed to align segment {i}, using original.")
                            elif not current_duration:
                                print(f"Could not get duration for {audio_path}")
                        else:
                            print(f"Audio file not found: {audio_path}")

                success = merge_audios_to_video(
                    video_path,
                    audio_segments,
                    output_path,
                    strategy=args.strategy,
                    audio_mix_mode=args.audio_mix_mode
                )
                if args.json:
                    return True, {"success": success, "output": output_path}
            except Exception as e:
                print(f"Error loading JSON or merging: {e}")
                if args.json:
                    return True, {"success": False, "error": str(e)}
        else:
            print("Usage: --action merge_video --input video.mp4 --ref segments.json --output final.mp4")
        return True, None

    if args.action == "analyze_video":
        if args.input:
            result_data = analyze_video(args.input)
            if not args.json:
                print(result_data)
            return True, result_data
        print("Please provide --input video path")
        return True, None

    if args.action == "transcode_video":
        if args.input and args.output:
            result_data = transcode_video(args.input, args.output)
            if not args.json:
                print(result_data)
            return True, result_data
        print("Usage: --action transcode_video --input in.mp4 --output out.mp4")
        return True, None

    if args.action == "dub_video":
        if args.input and args.output:
            target = args.lang if args.lang else "English"
            combined_kwargs = {**tts_kwargs, **extra_kwargs}
            result_data = dub_video(
                args.input,
                target,
                args.output,
                work_dir=args.work_dir,
                asr_service=args.asr,
                vad_onset=args.vad_onset,
                vad_offset=args.vad_offset,
                tts_service=args.tts_service,
                strategy=args.strategy,
                audio_mix_mode=args.audio_mix_mode,
                ori_lang=args.ori_lang,
                dub_retry_attempts=args.dub_retry_attempts,
                **combined_kwargs
            )
            if not args.json:
                print(result_data)
            return True, result_data
        print("Usage: --action dub_video --input video.mp4 --output dubbed.mp4 --lang 'Chinese'")
        return True, None

    if args.action == "check_audio_files":
        if args.input:
            try:
                try:
                    file_list = json.loads(args.input)
                except Exception:
                    file_list = [args.input]

                results = {}
                for path in file_list:
                    if os.path.exists(path):
                        results[path] = get_audio_duration(path) or 0.0
                    else:
                        results[path] = -1.0

                return True, {"success": True, "durations": results}
            except Exception as e:
                return True, {"success": False, "error": str(e)}
        return True, None

    return False, None
