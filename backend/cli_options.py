import argparse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="VideoSync Backend")
    parser.add_argument("--action", type=str, help="Action to perform: asr, tts, align, merge_video", default="test_asr")
    parser.add_argument("--input", type=str, help="Input file path or JSON string for complex inputs")
    parser.add_argument("--ref", type=str, help="Reference audio path for TTS (or segments JSON for batch)")
    parser.add_argument("--ref_audio", type=str, help="Explicit reference audio path (overrides auto-extraction)")
    parser.add_argument("--fallback_ref_audio", type=str, help="Fallback reference audio path used after per-segment retries")
    parser.add_argument("--fallback_ref_text", type=str, help="Transcript for fallback reference audio", default="")
    parser.add_argument("--nearby_ref_audios", type=str, help="JSON array of nearby successful audio paths used as intermediate fallback references")
    parser.add_argument("--output", type=str, help="Output path")
    parser.add_argument("--duration", type=float, help="Target duration in seconds for Alignment")
    parser.add_argument("--lang", type=str, help="Target language for translation/dubbing", default="English")
    parser.add_argument("--ori_lang", type=str, help="Source language for ASR", default="Chinese")
    parser.add_argument("--json", action="store_true", help="Output result as JSON")
    parser.add_argument("--text", type=str, help="Text to speak (for generate_single_tts)")
    parser.add_argument("--start", type=float, help="Start time in seconds (for generate_single_tts)", default=0.0)
    parser.add_argument("--model_dir", type=str, help="Path to models directory (HF_HOME)")
    parser.add_argument("--asr", type=str, help="ASR service to use: whisperx, jianying, bcut", default="whisperx")
    parser.add_argument("--temperature", type=float, help="TTS Temperature", default=0.8)
    parser.add_argument("--top_p", type=float, help="Top P", default=0.8)
    parser.add_argument("--repetition_penalty", type=float, help="Repetition Penalty", default=1.0)
    parser.add_argument("--cfg_scale", type=float, help="CFG Scale", default=0.7)
    parser.add_argument("--num_beams", type=int, help="Num Beams for beam search", default=1)
    parser.add_argument("--top_k", type=int, help="Top K sampling", default=5)
    parser.add_argument("--length_penalty", type=float, help="Length Penalty for beam search", default=1.0)
    parser.add_argument("--max_new_tokens", type=int, help="Max New Tokens (mel length limit)", default=2048)
    parser.add_argument("--strategy", type=str, help="Video sync strategy: auto_speedup, freeze_frame, frame_blend", default="auto_speedup")
    parser.add_argument(
        "--audio_mix_mode",
        type=str,
        help="Audio mix mode: preserve_background or replace_original",
        default="preserve_background"
    )
    parser.add_argument("--output_dir", type=str, help="Output directory for debug/intermediate files")
    parser.add_argument("--vad_onset", type=float, help="VAD onset threshold", default=0.700)
    parser.add_argument("--vad_offset", type=float, help="VAD offset threshold", default=0.700)
    parser.add_argument("--tts_service", type=str, help="TTS Service: indextts or qwen", default="indextts")
    parser.add_argument("--qwen_mode", type=str, help="Qwen TTS Mode: clone, design, preset", default="clone")
    parser.add_argument("--voice_instruct", type=str, help="Voice Design Instruction", default="")
    parser.add_argument("--preset_voice", type=str, help="Preset Voice for Qwen3", default="Vivian")
    parser.add_argument("--qwen_model_size", type=str, help="Qwen Model Size: 1.7B or 0.6B", default="1.7B")
    parser.add_argument("--qwen_ref_text", type=str, help="Reference text for Qwen Clone mode", default="")
    parser.add_argument("--batch_size", type=int, help="Batch Size for TTS", default=10)
    parser.add_argument("--dub_retry_attempts", type=int, help="Retry attempts for failed dubbing segments", default=3)
    parser.add_argument("--api_key", type=str, help="API Key for External Translation", default=None)
    parser.add_argument("--base_url", type=str, help="Base URL for External Translation", default=None)
    parser.add_argument("--model", type=str, help="Model Name for External Translation", default=None)
    return parser


def build_tts_kwargs(args: argparse.Namespace) -> dict:
    return {
        "temperature": args.temperature,
        "top_p": args.top_p,
        "top_k": args.top_k,
        "repetition_penalty": args.repetition_penalty,
        "inference_cfg_rate": args.cfg_scale,
        "cfg_scale": args.cfg_scale,
        "num_beams": args.num_beams,
        "length_penalty": args.length_penalty,
        "max_new_tokens": args.max_new_tokens,
        "qwen_mode": args.qwen_mode,
        "voice_instruct": args.voice_instruct,
        "preset_voice": args.preset_voice,
        "qwen_model_size": args.qwen_model_size,
        "qwen_ref_text": args.qwen_ref_text,
        "batch_size": args.batch_size,
        "ref_audio": args.ref_audio,
        "fallback_ref_audio": args.fallback_ref_audio,
        "fallback_ref_text": args.fallback_ref_text,
        "nearby_ref_audios": args.nearby_ref_audios
    }


def build_translation_kwargs(args: argparse.Namespace) -> dict:
    extra_kwargs = {}
    if args.api_key:
        extra_kwargs["api_key"] = args.api_key
        if args.base_url:
            extra_kwargs["base_url"] = args.base_url
        if args.model:
            extra_kwargs["model"] = args.model
    return extra_kwargs
