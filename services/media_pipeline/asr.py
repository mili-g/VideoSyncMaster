import os
import shutil
import subprocess
import sys
import tempfile
import logging

python_dir = os.path.dirname(sys.executable)
site_packages = os.path.join(python_dir, "Lib", "site-packages")
if os.path.exists(site_packages) and site_packages not in sys.path:
    sys.path.insert(0, site_packages)

from bootstrap.runtime_env import setup_gpu_paths
from bootstrap.path_layout import get_faster_whisper_runtime_search_roots

setup_gpu_paths(logging.getLogger("asr.runtime"))

# Lazy Imports
import re

from jianying import JianYingASR
from bcut import BcutASR
from asr_data import ASRData
from asr_chunking import (
    DEFAULT_CHUNK_LENGTH_SEC,
    DEFAULT_CHUNK_OVERLAP_SEC,
    get_audio_duration_seconds,
    merge_chunk_segments,
    split_audio_file,
)
from model_profiles import PROJECT_ROOT, PROJECT_ROOT_PROD, get_asr_profile, resolve_existing_path
from subtitle_postprocess import clean_segment_text, finalize_subtitle_segments, normalize_output_segments



BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))

DEFAULT_FASTER_WHISPER_MODEL_ID = "large-v3"

_WHISPER_LANGUAGE_MAP = {
    "": None,
    "none": None,
    "auto": None,
    "chinese": "zh",
    "zh": "zh",
    "english": "en",
    "en": "en",
    "japanese": "ja",
    "ja": "ja",
    "korean": "ko",
    "ko": "ko",
}

CLOUD_API_ASR_SERVICES = {"jianying", "bcut"}
LOCAL_ASR_SERVICES = {"faster-whisper", "funasr", "qwen", "vibevoice-asr"}

_HALLUCINATION_KEYWORDS = (
    "请不吝点赞 订阅 转发",
    "打赏支持明镜",
)

_FASTER_WHISPER_BINARY_CANDIDATES = {
    "cpu": ["faster-whisper-xxl", "faster-whisper"],
    "cuda": ["faster-whisper-xxl"],
}

_FW_CJK_MAX_LINE_WIDTH = 30
_FW_NON_CJK_MAX_LINE_WIDTH = 90
_FW_MAX_LINE_COUNT = 1
_FW_MAX_COMMA = 20
_FW_MAX_COMMA_CENT = 50


def _normalize_whisper_language(language):
    if language is None:
        return None
    normalized = str(language).strip().lower()
    return _WHISPER_LANGUAGE_MAP.get(normalized, normalized or None)


def _build_whisper_asr_options(language_code):
    asr_options = {}
    if language_code == "zh":
        asr_options["initial_prompt"] = "这是一段包含标点符号的中文对话，请使用逗号和句号。"
    return asr_options


def _build_language_hints(language_code):
    normalized = _normalize_whisper_language(language_code)
    prompt = None
    if normalized == "zh":
        prompt = "这是一段包含标点符号的中文对话，请使用逗号和句号。"
    return normalized, prompt


def _resolve_effective_asr_language(service, language):
    normalized = _normalize_whisper_language(language)
    if normalized in {None, "", "auto", "none"}:
        return None
    if service in CLOUD_API_ASR_SERVICES:
        print(
            f"[ASR] Ignoring explicit source-language hint for {service}: {language}. "
            "Current cloud integration only supports Auto mode.",
            flush=True,
        )
        return None
    return normalized


def _parse_bool_flag(value, default=True):
    if isinstance(value, bool):
        return value
    if value in (None, ""):
        return default
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _get_faster_whisper_device():
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _build_sentence_segments_from_aligned_result(aligned_segments):
    result = []
    for seg in aligned_segments:
        text = clean_segment_text(seg.get("text", ""))
        if not text:
            continue
        start = round(float(seg.get("start", 0.0)), 3)
        end = round(float(seg.get("end", start)), 3)
        if end <= start:
            end = round(start + 0.05, 3)
        result.append({
            "start": start,
            "end": end,
            "text": text,
        })
    return normalize_output_segments(result, hallucination_keywords=_HALLUCINATION_KEYWORDS)


def _build_pause_grouped_segments_from_word_items(
    word_items,
    *,
    gap_threshold=0.72,
    max_chars=36,
    max_duration=7.5,
):
    if not word_items:
        return []

    terminal_punctuation = {"。", "！", "？", "!", "?", ";", "；"}
    segments = []
    bucket = []

    def joined_text(items):
        texts = [str(item.get("text", "")).strip() for item in items if str(item.get("text", "")).strip()]
        merged = "".join(texts)
        has_cjk = any("\u4e00" <= char <= "\u9fff" for char in merged)
        return merged if has_cjk else " ".join(texts)

    def flush():
        nonlocal bucket
        if not bucket:
            return
        text = clean_segment_text(joined_text(bucket))
        if not text:
            bucket = []
            return
        segments.append(
            {
                "start": round(float(bucket[0]["start"]), 3),
                "end": round(float(bucket[-1]["end"]), 3),
                "text": text,
            }
        )
        bucket = []

    for index, word in enumerate(word_items):
        text = str(word.get("text", "")).strip()
        if not text:
            continue
        if bucket:
            gap = float(word["start"]) - float(bucket[-1]["end"])
            duration = float(bucket[-1]["end"]) - float(bucket[0]["start"])
            current_length = len(joined_text(bucket))
            if gap > gap_threshold or duration >= max_duration or current_length >= max_chars:
                flush()

        bucket.append(word)
        next_gap = None
        if index + 1 < len(word_items):
            next_gap = float(word_items[index + 1]["start"]) - float(word["end"])
        if text[-1:] in terminal_punctuation or (next_gap is not None and next_gap > gap_threshold):
            flush()

    flush()
    return normalize_output_segments(segments, hallucination_keywords=_HALLUCINATION_KEYWORDS)


def _finalize_local_segments(*args, **kwargs):
    return finalize_subtitle_segments(
        *args,
        hallucination_keywords=_HALLUCINATION_KEYWORDS,
        **kwargs,
    )


def _resolve_faster_whisper_program_path(program_name):
    direct_path = shutil.which(program_name)
    if direct_path:
        return direct_path

    filename = f"{program_name}.exe" if os.name == "nt" else program_name
    extra_root = os.environ.get("FASTER_WHISPER_BIN_DIR")
    search_roots = get_faster_whisper_runtime_search_roots(
        PROJECT_ROOT_PROD,
        backend_dir=BACKEND_DIR,
        legacy_project_root=PROJECT_ROOT,
        extra_root=extra_root,
    )

    def find_in_root(root_path):
        if not root_path:
            return None
        abs_root = os.path.abspath(root_path)
        direct_candidate = os.path.join(abs_root, filename)
        if os.path.exists(direct_candidate):
            return direct_candidate
        if not os.path.isdir(abs_root):
            return None
        for current_root, _, files in os.walk(abs_root):
            if filename in files:
                return os.path.join(current_root, filename)
        return None

    for root in search_roots:
        candidate = find_in_root(root)
        if candidate:
            return candidate
    return None


def _resolve_faster_whisper_runtime():
    device = _get_faster_whisper_device()

    for program_name in _FASTER_WHISPER_BINARY_CANDIDATES[device]:
        program_path = _resolve_faster_whisper_program_path(program_name)
        if program_path:
            vad_method = "silero_v4" if program_name == "faster-whisper-xxl" else ""
            return {
                "device": device,
                "program_name": program_name,
                "program_path": program_path,
                "vad_method": vad_method,
            }

    expected_names = ", ".join(_FASTER_WHISPER_BINARY_CANDIDATES[device])
    raise FileNotFoundError(
        f"Required faster-whisper binary not found for device={device}. Expected one of: {expected_names}."
    )


def _resolve_faster_whisper_execution_plan():
    runtime = _resolve_faster_whisper_runtime()
    return {
        "mode": "binary",
        "source": "default",
        "runtime": runtime,
        "detail": f"binary:{runtime['program_name']} device={runtime['device']}",
    }


def _build_faster_whisper_output_path(output_dir, audio_path):
    base_name = os.path.splitext(os.path.basename(audio_path))[0]
    return os.path.join(output_dir, f"{base_name}.srt")


def _resolve_faster_whisper_model_name(model_dir):
    basename = os.path.basename(os.path.abspath(model_dir)).lower()
    if "large-v3" in basename or os.path.isdir(os.path.join(model_dir, "faster-whisper-large-v3")):
        return "large-v3"
    if "large-v3-turbo" in basename or os.path.isdir(os.path.join(model_dir, "faster-whisper-large-v3-turbo")):
        return "large-v3-turbo"
    return DEFAULT_FASTER_WHISPER_MODEL_ID


def _ensure_faster_whisper_model_layout(model_dir, model_name):
    alias_dir_name = f"faster-whisper-{model_name}" if not model_name.startswith("faster-whisper-") else model_name
    alias_dir = os.path.join(model_dir, alias_dir_name)
    os.makedirs(alias_dir, exist_ok=True)

    for file_name in os.listdir(model_dir):
        source_path = os.path.join(model_dir, file_name)
        target_path = os.path.join(alias_dir, file_name)
        if not os.path.isfile(source_path) or os.path.exists(target_path):
            continue
        try:
            os.link(source_path, target_path)
        except OSError:
            shutil.copy2(source_path, target_path)
    return model_name


def _build_faster_whisper_command(
    audio_path,
    model_path,
    model_dir,
    runtime,
    language=None,
    need_word_timestamps=False,
    vad_filter=True,
    vad_threshold=0.4,
):
    normalized_language, initial_prompt = _build_language_hints(language)
    cmd = [
        runtime["program_path"],
        "-m",
        model_path,
        "--model_dir",
        model_dir,
        audio_path,
        "-d",
        runtime["device"],
        "--output_format",
        "srt",
        "--print_progress",
        "--beep_off",
        "-o",
        os.path.dirname(audio_path),
    ]
    if vad_filter:
        cmd.extend(["--vad_filter", "true", "--vad_threshold", f"{float(vad_threshold):.2f}"])
    cmd.append("--standard")
    if normalized_language:
        cmd.extend(["-l", normalized_language])
    if initial_prompt:
        cmd.extend(["--initial_prompt", initial_prompt])
    return cmd


def _is_faster_whisper_output_complete(output_path, output_lines, expected_duration_sec):
    try:
        segments = _load_segments_from_srt(output_path)
    except Exception as error:
        print(f"[FasterWhisper] Failed to parse subtitle output for integrity check: {error}")
        return False

    if not segments:
        return False

    max_end = max(float(segment.get("end", 0.0) or 0.0) for segment in segments)
    finished_marker = any(
        "operation finished" in line.lower() or "transcription speed" in line.lower() or "| 100% |" in line.lower()
        for line in output_lines
    )
    if expected_duration_sec <= 0:
        return finished_marker and max_end > 0

    coverage_ratio = max_end / max(expected_duration_sec, 0.001)
    minimum_coverage = 0.55 if expected_duration_sec <= 20 else 0.7
    return finished_marker and coverage_ratio >= minimum_coverage


def _run_faster_whisper_command(cmd, output_path, *, expected_duration_sec=0.0):
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=creationflags,
    )
    output_lines = []
    for line in process.stdout or []:
        line = line.rstrip()
        if line:
            output_lines.append(line)
            try:
                print(f"[FasterWhisper] {line}")
            except UnicodeEncodeError:
                terminal_encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
                safe_line = line.encode(terminal_encoding, errors="replace").decode(terminal_encoding, errors="replace")
                print(f"[FasterWhisper] {safe_line}")
    return_code = process.wait()

    output_exists = os.path.exists(output_path)
    output_has_content = output_exists and os.path.getsize(output_path) > 0

    if return_code != 0:
        if output_has_content and _is_faster_whisper_output_complete(output_path, output_lines, expected_duration_sec):
            print(
                "[FasterWhisper] Process exited with non-zero code "
                f"{return_code}, but subtitle output passed integrity checks. Accepting generated subtitles."
            )
            return

        partial_output_note = (
            f" Partial subtitle output at {output_path} was discarded."
            if output_has_content
            else ""
        )
        raise RuntimeError(
            "faster-whisper process failed with exit code "
            f"{return_code}:{partial_output_note} {' | '.join(output_lines[-20:])}"
        )

    if not output_exists:
        raise FileNotFoundError(f"faster-whisper output file not found: {output_path}")
    if not output_has_content:
        raise RuntimeError(f"faster-whisper output file is empty: {output_path}")


def _discard_partial_faster_whisper_output(output_path):
    try:
        if os.path.exists(output_path):
            os.remove(output_path)
    except OSError as error:
        print(f"[FasterWhisper] Failed to remove partial subtitle output {output_path}: {error}")


def _load_segments_from_srt(srt_path):
    with open(srt_path, "r", encoding="utf-8") as handle:
        asr_data = ASRData.from_srt(handle.read())
    asr_data.optimize_timing()
    segments = []
    for seg in asr_data.segments:
        segments.append({
            "start": round(seg.start_time / 1000.0, 3),
            "end": round(seg.end_time / 1000.0, 3),
            "text": seg.text,
        })
    return normalize_output_segments(segments, hallucination_keywords=_HALLUCINATION_KEYWORDS)


def _should_use_chunked_local_asr(service, audio_path, chunking_in_progress):
    if chunking_in_progress:
        return False
    if service not in {"qwen", "vibevoice-asr", "funasr", "faster-whisper"}:
        return False
    if service == "faster-whisper":
        return False

    try:
        duration = get_audio_duration_seconds(audio_path)
    except Exception as error:
        print(f"[ASRChunk] Failed to probe duration for chunking decision: {error}")
        return False

    return duration > (DEFAULT_CHUNK_LENGTH_SEC + DEFAULT_CHUNK_OVERLAP_SEC)


def _run_chunked_local_asr(
    audio_path,
    service,
    output_dir,
    vad_onset,
    vad_offset,
    language,
    splitter_kwargs,
    apply_splitter=True,
    model_profile=None,
    faster_whisper_vad_filter=True,
    faster_whisper_vad_threshold=0.4,
    local_asr_device="auto",
    local_asr_max_inference_batch_size=32,
    local_asr_max_new_tokens=256,
    funasr_batch_size_s=300,
    funasr_merge_vad=True,
    qwen_device="auto",
    qwen_max_inference_batch_size=32,
    qwen_max_new_tokens=256,
):
    print(f"[ASRChunk] Starting chunked local ASR for {audio_path}")
    chunk_length_sec = DEFAULT_CHUNK_LENGTH_SEC
    chunk_overlap_sec = DEFAULT_CHUNK_OVERLAP_SEC
    chunk_results = []
    chunk_offsets = []
    chunks, temp_dir = split_audio_file(
        audio_path,
        chunk_length_sec=chunk_length_sec,
        chunk_overlap_sec=chunk_overlap_sec,
    )
    try:
        for index, (chunk_path, offset_sec) in enumerate(chunks, start=1):
            chunk_duration = get_audio_duration_seconds(chunk_path)
            print(
                f"[ASRChunk] Processing chunk {index}/{len(chunks)} "
                f"offset={offset_sec:.2f}s duration={chunk_duration:.1f}s file={os.path.basename(chunk_path)}"
            )
            chunk_segments = run_asr(
                chunk_path,
                service=service,
                output_dir=output_dir,
                vad_onset=vad_onset,
                vad_offset=vad_offset,
                language=language,
                splitter_kwargs=splitter_kwargs,
                apply_splitter=False,
                chunking_in_progress=True,
                model_profile=model_profile,
                faster_whisper_vad_filter=faster_whisper_vad_filter,
                faster_whisper_vad_threshold=faster_whisper_vad_threshold,
                local_asr_device=local_asr_device,
                local_asr_max_inference_batch_size=local_asr_max_inference_batch_size,
                local_asr_max_new_tokens=local_asr_max_new_tokens,
                funasr_batch_size_s=funasr_batch_size_s,
                funasr_merge_vad=funasr_merge_vad,
                qwen_device=qwen_device,
                qwen_max_inference_batch_size=qwen_max_inference_batch_size,
                qwen_max_new_tokens=qwen_max_new_tokens,
            )
            chunk_results.append(chunk_segments)
            chunk_offsets.append(offset_sec)
            print(
                f"[ASRChunk] Chunk {index}/{len(chunks)} complete "
                f"segments={len(chunk_segments)} offset={offset_sec:.2f}s"
            )

        merged_segments = merge_chunk_segments(
            chunk_results,
            chunk_offsets=chunk_offsets,
            overlap_duration=chunk_overlap_sec,
        )
        final_segments = _finalize_local_segments(
            merged_segments,
            splitter_kwargs=splitter_kwargs,
            apply_splitter=apply_splitter,
            optimize_enabled=True,
        )
        print(f"[ASRChunk] Chunk merge complete. Final segments: {len(final_segments)}")
        return final_segments
    finally:
        temp_dir.cleanup()


def _resolve_faster_whisper_model_config(model_profile=None):
    profile_key, profile = get_asr_profile("faster-whisper", model_profile)
    model_dir = resolve_existing_path(profile.get("candidates"))
    return {
        "profile_key": profile_key,
        "label": str(profile.get("label") or DEFAULT_FASTER_WHISPER_MODEL_ID),
        "model_name": str(profile.get("model_name") or DEFAULT_FASTER_WHISPER_MODEL_ID),
        "model_dir": model_dir,
        "candidates": list(profile.get("candidates") or []),
    }


def _run_faster_whisper_local(
    audio_path,
    language=None,
    splitter_kwargs=None,
    apply_splitter=True,
    output_dir=None,
    model_profile=None,
    optimize_output=True,
    faster_whisper_vad_filter=True,
    faster_whisper_vad_threshold=0.4,
):
    model_config = _resolve_faster_whisper_model_config(model_profile)
    model_dir = model_config["model_dir"]
    if not model_dir:
        raise FileNotFoundError(
            f"Local faster-whisper model not found for profile={model_config['profile_key']}. "
            f"Expected one of: {', '.join(model_config['candidates'])}"
        )

    execution_plan = _resolve_faster_whisper_execution_plan()
    runtime = execution_plan["runtime"]
    print(f"[FasterWhisper] Using binary: {runtime['program_path']}")
    print(f"[FasterWhisper] Device: {runtime['device']}")
    print(f"[FasterWhisper] Model dir: {model_dir}")

    source_ext = os.path.splitext(audio_path)[1] or ".wav"
    with tempfile.TemporaryDirectory(prefix="vsm_fw_") as temp_dir:
        temp_audio_path = os.path.join(temp_dir, f"input{source_ext}")
        shutil.copy2(audio_path, temp_audio_path)
        output_path = _build_faster_whisper_output_path(temp_dir, temp_audio_path)
        expected_duration_sec = get_audio_duration_seconds(temp_audio_path)
        model_name = _ensure_faster_whisper_model_layout(
            model_dir,
            _resolve_faster_whisper_model_name(model_dir),
        )
        cmd = _build_faster_whisper_command(
            audio_path=temp_audio_path,
            model_path=model_name,
            model_dir=model_dir,
            runtime=runtime,
            language=language,
            need_word_timestamps=apply_splitter,
            vad_filter=_parse_bool_flag(faster_whisper_vad_filter, default=True),
            vad_threshold=faster_whisper_vad_threshold,
        )
        try:
            _run_faster_whisper_command(cmd, output_path, expected_duration_sec=expected_duration_sec)
            raw_segments = _load_segments_from_srt(output_path)

            return _finalize_local_segments(
                raw_segments,
                splitter_kwargs=splitter_kwargs,
                apply_splitter=apply_splitter,
                optimize_enabled=optimize_output,
            )
        except Exception as primary_error:
            _discard_partial_faster_whisper_output(output_path)
            print(
                "[FasterWhisper] Primary transcription attempt failed. "
                "Retrying once with conservative sentence mode."
            )
            retry_cmd = _build_faster_whisper_command(
                audio_path=temp_audio_path,
                model_path=model_name,
                model_dir=model_dir,
                runtime=runtime,
                language=language,
                need_word_timestamps=False,
                vad_filter=_parse_bool_flag(faster_whisper_vad_filter, default=True),
                vad_threshold=faster_whisper_vad_threshold,
            )
            try:
                _run_faster_whisper_command(retry_cmd, output_path, expected_duration_sec=expected_duration_sec)
                raw_segments = _load_segments_from_srt(output_path)
                return _finalize_local_segments(
                    raw_segments,
                    splitter_kwargs=splitter_kwargs,
                    apply_splitter=False,
                    optimize_enabled=optimize_output,
                )
            except Exception as retry_error:
                _discard_partial_faster_whisper_output(output_path)
                raise RuntimeError(
                    "faster-whisper failed in both primary and conservative retry modes. "
                    f"Primary error: {primary_error} | Retry error: {retry_error}"
                ) from retry_error




def run_asr(
    audio_path,
    model_path=None,
    service="faster-whisper",
    output_dir=None,
    vad_onset=0.700,
    vad_offset=0.700,
    language=None,
    splitter_kwargs=None,
    apply_splitter=True,
    chunking_in_progress=False,
    model_profile=None,
    faster_whisper_vad_filter=True,
    faster_whisper_vad_threshold=0.4,
    local_asr_device="auto",
    local_asr_max_inference_batch_size=32,
    local_asr_max_new_tokens=256,
    funasr_batch_size_s=300,
    funasr_merge_vad=True,
    qwen_device="auto",
    qwen_max_inference_batch_size=32,
    qwen_max_new_tokens=256,
):
    """
    Run ASR using local providers or cloud APIs.
    """
    effective_local_asr_device = local_asr_device or qwen_device or "auto"
    effective_local_asr_max_inference_batch_size = max(
        1,
        int(local_asr_max_inference_batch_size or qwen_max_inference_batch_size or 32)
    )
    effective_local_asr_max_new_tokens = max(
        32,
        int(local_asr_max_new_tokens or qwen_max_new_tokens or 256)
    )

    # Keep legacy Qwen-prefixed parameters as aliases until all callers are migrated.
    qwen_device = effective_local_asr_device
    qwen_max_inference_batch_size = effective_local_asr_max_inference_batch_size
    qwen_max_new_tokens = effective_local_asr_max_new_tokens


    
    # If input is video, extract audio first
    ext = os.path.splitext(audio_path)[1].lower()
    if ext in ['.mp4', '.mkv', '.avi', '.mov', '.flv']:
        import hashlib
        
        # Create cache directory
        if output_dir:
            cache_dir = output_dir
        else:
            # Fallback to Project Root .cache (parent of backend)
            cache_dir = os.path.join(BACKEND_DIR, "..", ".cache")
            
        os.makedirs(cache_dir, exist_ok=True)
        
        # Generare unique filename based on absolute path
        abs_path = os.path.abspath(audio_path)
        file_hash = hashlib.md5(abs_path.encode('utf-8')).hexdigest()
        cached_audio = os.path.join(cache_dir, f"{file_hash}.mp3")
        
        if os.path.exists(cached_audio) and os.path.getsize(cached_audio) > 0:
             print(f"Using cached audio: {cached_audio}")
             audio_path = cached_audio
        else:
            if os.path.exists(cached_audio):
                print(f"Cached audio is empty (0 bytes), re-extracting...")
                try:
                    os.remove(cached_audio)
                except OSError:
                    pass
            
            print(f"Extracting audio to {cached_audio}...")
            try:
                from pydub import AudioSegment
                AudioSegment.from_file(audio_path).export(cached_audio, format="mp3")
                audio_path = cached_audio
            except Exception as e:
                print(f"Audio extraction failed: {e}")
                # Fallback to original path if extraction fails (though likely will fail later)
                pass

    if _should_use_chunked_local_asr(service, audio_path, chunking_in_progress):
        return _run_chunked_local_asr(
            audio_path,
            service,
            output_dir,
            vad_onset,
            vad_offset,
            language,
            splitter_kwargs,
            apply_splitter=apply_splitter,
            model_profile=model_profile,
            faster_whisper_vad_filter=faster_whisper_vad_filter,
            faster_whisper_vad_threshold=faster_whisper_vad_threshold,
            local_asr_device=effective_local_asr_device,
            local_asr_max_inference_batch_size=effective_local_asr_max_inference_batch_size,
            local_asr_max_new_tokens=effective_local_asr_max_new_tokens,
            funasr_batch_size_s=funasr_batch_size_s,
            funasr_merge_vad=funasr_merge_vad,
            qwen_device=qwen_device,
            qwen_max_inference_batch_size=qwen_max_inference_batch_size,
            qwen_max_new_tokens=qwen_max_new_tokens,
        )

    if service == "funasr":
        print(f"Running FunASR on {audio_path}")
        try:
            from funasr_asr_service import run_funasr_asr_inference
            return run_funasr_asr_inference(
                audio_path,
                model_profile=model_profile or "standard",
                language=language,
                splitter_kwargs=splitter_kwargs,
                device=effective_local_asr_device,
                batch_size_s=max(1, int(funasr_batch_size_s or 300)),
                merge_vad=_parse_bool_flag(funasr_merge_vad, default=True),
                optimize_enabled=not chunking_in_progress,
            )
        except Exception as e:
            print(f"FunASR execution failed: {e}")
            raise RuntimeError(f"FunASR execution failed: {e}") from e

    if service == "jianying":
        language = _resolve_effective_asr_language(service, language)
        print(f"Running JianYing ASR on {audio_path}")
        asr = JianYingASR(audio_path, need_word_time_stamp=False)
        asr_data = asr.run()
        segments = []
        for seg in asr_data.segments:
            segments.append({
                "start": seg.start_time / 1000.0,
                "end": seg.end_time / 1000.0,
                "text": seg.text
            })
        print(f"JianYing ASR complete. {len(segments)} segments.")
        return _finalize_local_segments(
            segments,
            splitter_kwargs=splitter_kwargs,
            apply_splitter=apply_splitter,
            optimize_enabled=not chunking_in_progress,
        )

    elif service == "bcut":
        language = _resolve_effective_asr_language(service, language)
        print(f"Running Bcut ASR on {audio_path}")
        asr = BcutASR(audio_path, need_word_time_stamp=False)
        asr_data = asr.run()
        segments = []
        for seg in asr_data.segments:
            segments.append({
                "start": seg.start_time / 1000.0,
                "end": seg.end_time / 1000.0,
                "text": seg.text
            })
        print(f"Bcut ASR complete. {len(segments)} segments.")
        return _finalize_local_segments(
            segments,
            splitter_kwargs=splitter_kwargs,
            apply_splitter=apply_splitter,
            optimize_enabled=not chunking_in_progress,
        )

    elif service == "qwen":
        print(f"Running Qwen3-ASR on {audio_path}")
        try:
            from qwen_asr_service import run_qwen_asr_inference
            segments = run_qwen_asr_inference(
                audio_path,
                model_name=(get_asr_profile("qwen", model_profile)[1].get("model_name") or "Qwen3-ASR-1.7B"),
                language=language,
                splitter_kwargs=splitter_kwargs,
                device=qwen_device,
                max_inference_batch_size=qwen_max_inference_batch_size,
                max_new_tokens=qwen_max_new_tokens,
            )
            return _finalize_local_segments(
                segments,
                splitter_kwargs=splitter_kwargs,
                apply_splitter=apply_splitter,
                optimize_enabled=not chunking_in_progress,
            )
        except ImportError as e:
            print(f"Failed to import Qwen ASR service: {e}")
            raise RuntimeError(f"Failed to import Qwen ASR service: {e}") from e
        except Exception as e:
            print(f"Qwen ASR execution failed: {e}")
            raise RuntimeError(f"Qwen ASR execution failed: {e}") from e

    elif service == "vibevoice-asr":
        print(f"Running VibeVoice-ASR on {audio_path}")
        try:
            from vibevoice_asr_service import run_vibevoice_asr_inference
            segments = run_vibevoice_asr_inference(
                audio_path,
                model_name=(get_asr_profile("vibevoice-asr", model_profile)[1].get("model_name") or "VibeVoice-ASR-HF"),
                language=language,
                device=qwen_device,
                max_new_tokens=qwen_max_new_tokens,
            )
            return _finalize_local_segments(
                segments,
                splitter_kwargs=splitter_kwargs,
                # VibeVoice returns its own sentence timestamps and speaker boundaries.
                # Running the generic splitter would convert them to pseudo word timestamps
                # and re-segment by estimated duration, which corrupts the original timeline.
                apply_splitter=False,
                optimize_enabled=not chunking_in_progress,
            )
        except Exception as e:
            print(f"VibeVoice-ASR execution failed: {e}")
            raise RuntimeError(f"VibeVoice-ASR execution failed: {e}") from e

    elif service == "faster-whisper":
        print(f"Running faster-whisper on {audio_path}")
        try:
            return _run_faster_whisper_local(
                audio_path,
                language=language,
                splitter_kwargs=splitter_kwargs,
                apply_splitter=apply_splitter,
                output_dir=output_dir,
                model_profile=model_profile,
                optimize_output=not chunking_in_progress,
                faster_whisper_vad_filter=faster_whisper_vad_filter,
                faster_whisper_vad_threshold=faster_whisper_vad_threshold,
            )
        except Exception as e:
            print(f"faster-whisper execution failed: {e}")
            raise RuntimeError(f"faster-whisper execution failed: {e}") from e

    elif service == "whisperx":
        raise RuntimeError(
            "WhisperX has been removed from the active local ASR stack. "
            "Please switch to faster-whisper, FunASR, Qwen3-ASR, VibeVoice-ASR, jianying, or bcut."
        )

    raise RuntimeError(
        f"Unsupported ASR service: {service}. "
        "Please switch to faster-whisper, FunASR, Qwen3-ASR, VibeVoice-ASR, jianying, or bcut."
    )
