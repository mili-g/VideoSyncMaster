import sys
import os
# import torch # Moved to inside main/functions for safety
import pathlib
import builtins
import logging
current_script_dir = os.path.dirname(os.path.abspath(__file__))
if current_script_dir not in sys.path:
    sys.path.insert(0, current_script_dir)
from app_logging import get_logger, log_business, log_debug, log_error, log_security, redirect_print

# FORCE IMMEDIATE FLUSH
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

# [USER REQUEST] Force Offline for manual handling of models
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ["PYTHONUTF8"] = "1"
os.environ["PYTHONIOENCODING"] = "utf-8"
os.environ["NUMBA_DISABLE_INTEL_SVML"] = "1"
os.environ["NUMBA_CPU_NAME"] = "generic"

# Force UTF-8 for stdout/stderr
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


import subprocess

_original_popen = subprocess.Popen

class EncodingSafePopen(_original_popen):
    def __init__(self, *args, **kwargs):
        text_mode = (
            kwargs.get("text")
            or kwargs.get("universal_newlines")
            or (kwargs.get("encoding") is not None)
        )
        if text_mode:
            kwargs.setdefault("encoding", "utf-8")
            kwargs.setdefault("errors", "replace")
        super().__init__(*args, **kwargs)

subprocess.Popen = EncodingSafePopen

logger = get_logger("main")
_stdout_print = builtins.print
print = redirect_print(logger, default_level=logging.DEBUG)

from event_protocol import clear_event_context, emit_issue, emit_partial_result, emit_progress, emit_stage, scoped_event_context, set_event_context

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
# With flat structure, APP_ROOT is consistently the parent of backend/
APP_ROOT = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
# Detect production by checking for app.asar (typically in resources/) or if sys is frozen
IS_PROD = os.path.exists(os.path.join(APP_ROOT, "resources", "app.asar")) or getattr(sys, 'frozen', False)

# Logging to "logs" folder in App Root (or Project Root)
log_dir = os.path.join(APP_ROOT, "logs")
log_file = os.path.join(log_dir, "backend_debug.log")
MAX_LOG_FILE_BYTES = 2 * 1024 * 1024
LOG_TAIL_BYTES = 256 * 1024
ENABLE_STREAM_TEE = os.environ.get("VSM_BACKEND_TEE_LOG", "0") == "1"

try:
    if not os.path.exists(log_dir):
        os.makedirs(log_dir, exist_ok=True)

    if os.path.exists(log_file):
        try:
            current_size = os.path.getsize(log_file)
            if current_size > MAX_LOG_FILE_BYTES:
                with open(log_file, "rb") as src:
                    src.seek(max(0, current_size - LOG_TAIL_BYTES))
                    tail = src.read()
                with open(log_file, "wb") as dst:
                    dst.write(tail)
        except Exception:
            pass
        
    def debug_log(msg):
        try:
            with open(log_file, "a", encoding="utf-8") as f:
                import datetime
                ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                f.write(f"[{ts}] {msg}\n")
        except:
            builtins.print(f"Log Error: {msg}", file=sys.stderr)

    debug_log("Backend starting...")
    debug_log(f"Executable: {sys.executable}")
    debug_log(f"CWD: {os.getcwd()}")
    debug_log(f"App Root: {APP_ROOT}")
    debug_log(f"Is Prod: {IS_PROD}")

except Exception as e:
    builtins.print(f"Logging setup failed: {e}", file=sys.stderr)
    # Fallback logger
    def debug_log(msg):
        builtins.print(f"[LOG_FAIL] {msg}", file=sys.stderr)

def exception_hook(exc_type, exc_value, exc_traceback):
    import traceback
    error_msg = "".join(traceback.format_exception(exc_type, exc_value, exc_traceback))
    try:
        debug_log(f"UNHANDLED EXCEPTION:\n{error_msg}")
    except:
        pass
    sys.__excepthook__(exc_type, exc_value, exc_traceback)

sys.excepthook = exception_hook



if not getattr(sys, 'frozen', False):
    try:
        # Portable python is expected to be in APP_ROOT/python/python.exe
        portable_python = os.path.join(APP_ROOT, "python", "python.exe")
        
        if os.path.exists(portable_python):
            # Normalize paths for comparison
            target_py = os.path.abspath(portable_python).lower()
            current_py = sys.executable.lower()
            
            if target_py != current_py:
                log_security(logger, logging.WARNING, "Relaunching with portable python", event="python_relaunch", stage="bootstrap", detail=target_py)
                # Ensure we pass all original arguments
                cmd = [target_py, __file__] + sys.argv[1:]
                
                # Pass environment but ensure PATH includes python Scripts/Lib (optional, but good)
                env = os.environ.copy()
                
                # Execute
                ret = subprocess.call(cmd, env=env)
                sys.exit(ret)
                
    except Exception as e:
        log_error(logger, "Failed to enforce portable python", event="python_relaunch_failed", stage="bootstrap", detail=str(e))

class DualWriter:
    def __init__(self, file_path, original_stream):
        self.file = open(file_path, "a", encoding="utf-8", buffering=1)
        self.original_stream = original_stream

    def write(self, message):
        try:
            self.file.write(message)
            self.original_stream.write(message)
            self.original_stream.flush()
        except:
            pass

    def flush(self):
        try:
            self.file.flush()
            self.original_stream.flush()
        except:
            pass

if log_file and ENABLE_STREAM_TEE:
    sys.stdout = DualWriter(log_file, sys.stdout)
    sys.stderr = DualWriter(log_file, sys.stderr)

# ... (Logging setup done) ...

if not getattr(sys, 'frozen', False):
    # (Portable python check kept as is)
    pass

# Check for --model_dir in sys.argv
MODELS_HUB_DIR = None
if "--model_dir" in sys.argv:
    try:
        idx = sys.argv.index("--model_dir")
        if idx + 1 < len(sys.argv):
            MODELS_HUB_DIR = os.path.abspath(sys.argv[idx + 1])
    except:
        pass

if not MODELS_HUB_DIR:
    # Search for models in common locations
    possible_paths = [
        os.path.join(APP_ROOT, "models", "index-tts", "hub"),  # User installed in Root
        os.path.join(APP_ROOT, "resources", "models", "index-tts", "hub"), # User copied to resources
        os.path.join(CURRENT_DIR, "..", "models", "index-tts", "hub") # Dev / Default
    ]
    
    print(f"[DEBUG] APP_ROOT detected as: {APP_ROOT}")
    print(f"[DEBUG] Checking model paths:")
    
    for p in possible_paths:
        exists = os.path.exists(p)
        content_len = len(os.listdir(p)) if exists else 0
        print(f"  - {p} (Exists: {exists}, Items: {content_len})")
        
        if exists:
            # Check if it actually has content (not just empty folder)
            if content_len > 0: 
                MODELS_HUB_DIR = p
                print(f"  [SELECTED] Found valid model dir at: {p}")
                break
    
    # Fallback if none found with content
    if not MODELS_HUB_DIR:
         print("  [WARNING] No valid model dir found in candidates. Defaulting to Root path.")
         MODELS_HUB_DIR = os.path.join(APP_ROOT, "models", "index-tts", "hub")

if not os.path.exists(MODELS_HUB_DIR):
    log_error(logger, "Model directory not found", event="model_dir_missing", stage="bootstrap", detail=MODELS_HUB_DIR)
    log_business(logger, logging.WARNING, "Local WhisperX models unavailable; API services remain available", event="model_dir_missing", stage="bootstrap")
    # Don't exit, allow startup for API usage
    # sys.exit(1)
    
log_business(logger, logging.INFO, "Models directory resolved", event="model_dir_ready", stage="bootstrap", detail=MODELS_HUB_DIR)

os.environ["HF_HOME"] = MODELS_HUB_DIR
os.environ["HF_HUB_CACHE"] = MODELS_HUB_DIR
# 禁用 HuggingFace 自动下载
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

# Setup Portable FFmpeg
# In prod, we bundle ffmpeg into the backend folder, so relative path is same
sys_frozen = getattr(sys, 'frozen', False)
backend_root = os.path.dirname(os.path.abspath(sys.executable)) if sys_frozen else os.path.dirname(os.path.abspath(__file__))
ffmpeg_bin = os.path.join(backend_root, "ffmpeg", "bin")

if os.path.exists(os.path.join(ffmpeg_bin, "ffmpeg.exe")):
    log_business(logger, logging.INFO, "Using portable FFmpeg", event="ffmpeg_ready", stage="bootstrap", detail=ffmpeg_bin)
    os.environ["PATH"] = ffmpeg_bin + os.pathsep + os.environ["PATH"]
else:
    log_business(logger, logging.WARNING, "Portable FFmpeg not found, falling back to system PATH", event="ffmpeg_fallback", stage="bootstrap")

def setup_gpu_paths():
    """
    Add PyTorch and NVIDIA cuDNN directories to PATH and DLL search path.
    Essential for Windows portable environments to find cudnn_ops_infer64_8.dll etc.
    MUST be called before 'import torch' to prevent DLL load crashes.
    """
    try:
        # Helper to add valid paths
        def add_path(path):
            if os.path.exists(path):
                # 1. Add to PATH
                if path not in os.environ["PATH"]:
                    os.environ["PATH"] = path + os.pathsep + os.environ["PATH"]
                    # print(f"[DEBUG] Added to PATH: {path}")
                
                # 2. Add to DLL Directory (Python 3.8+ Windows)
                if hasattr(os, 'add_dll_directory'):
                    try:
                        os.add_dll_directory(path)
                        # print(f"[DEBUG] Added DLL Directory: {path}")
                    except Exception as e:
                        pass

        # 1. Proactively add portable python paths (Pre-import fix for hard crashes)
        # This guesses the location of site-packages relative to python.exe
        base_dir = os.path.dirname(sys.executable)
        
        # Candidate: Lib/site-packages (Windows Default/Portable)
        site_packages = os.path.join(base_dir, "Lib", "site-packages")
        if not os.path.exists(site_packages):
             # Try lowercase/variants
             site_packages = os.path.join(base_dir, "lib", "site-packages")

        if os.path.exists(site_packages):
            # Add NVIDIA dependencies explicitly BEFORE torch import
            nvidia_packages = ["cudnn", "cublas", "cuda_runtime", "cudart"]
            for pkg in nvidia_packages:
                for sub in ["bin", "lib"]: # Check both bin and lib
                    p = os.path.join(site_packages, "nvidia", pkg, sub)
                    add_path(p)

            # Add torch/lib
            add_path(os.path.join(site_packages, "torch", "lib"))
        
        # 2. Also try via standard import if it works (Double check)
        try:
            import torch
            torch_path = os.path.dirname(torch.__file__)
            add_path(os.path.join(torch_path, 'lib'))
            
            site_pkgs = os.path.dirname(os.path.dirname(torch.__file__))
            add_path(os.path.join(site_pkgs, "nvidia", "cudnn", "bin"))
        except:
            pass # Ignore import errors here, we relied on heuristic above

    except Exception as e:
        log_error(logger, "Failed to patch DLL paths", event="dll_patch_failed", stage="bootstrap", detail=str(e))


# Apply DLL path patching before importing any ASR/TTS modules that may load torch/cuDNN.
setup_gpu_paths()

# 238:
# Lazy Imports moved to functions or after dependency checks
from asr import run_asr
from alignment import align_audio, get_audio_duration, merge_audios_to_video
try:
    import librosa
    import soundfile as sf
except ImportError:
    pass # Will handle later or assume installed, get_audio_duration
import ffmpeg
import json
import shutil
from action_handlers import dispatch_basic_action
from cli_options import build_parser, build_tts_kwargs, build_translation_kwargs
from dependency_manager import ensure_transformers_version, check_gpu_deps
from error_model import emit_error_issue, error_result, exception_result, make_error
from runtime_config import build_dub_video_runtime_config
from tts_action_handlers import generate_batch_tts_results, handle_generate_batch_tts, handle_generate_single_tts, handle_prepare_reference_audio

# Global TTS entry points (lazy loaded)
_run_tts = None
_run_batch_tts = None
_loaded_tts_service = None
_llm_translator_class = None


def get_llm_translator_class():
    global _llm_translator_class
    if _llm_translator_class is None:
        from llm import LLMTranslator
        _llm_translator_class = LLMTranslator
    return _llm_translator_class

def get_tts_runner(service="indextts", check_deps=True):
    global _run_tts, _run_batch_tts, _loaded_tts_service

    if _loaded_tts_service == service and _run_tts and _run_batch_tts:
        return _run_tts, _run_batch_tts
    
    # Dependency Check
    if check_deps:
        if service == "qwen":
            log_business(logger, logging.INFO, "Ensuring dependencies for Qwen3-TTS", event="deps_check", stage="bootstrap")
            setup_gpu_paths()
            if ensure_transformers_version("4.57.3"):
                 check_gpu_deps()
                 log_business(logger, logging.INFO, "Qwen3 dependencies ready", event="deps_ready", stage="bootstrap")
            else:
                 log_error(logger, "Failed to setup Qwen3 dependencies", event="deps_failed", stage="bootstrap", code="QWEN_DEPS_FAILED")
                 return None, None
        else:
            # Default/IndexTTS
            log_business(logger, logging.INFO, "Ensuring dependencies for IndexTTS", event="deps_check", stage="bootstrap")
            if ensure_transformers_version("4.52.1"):
                 log_business(logger, logging.INFO, "IndexTTS dependencies ready", event="deps_ready", stage="bootstrap")
            else:
                 log_error(logger, "Failed to setup IndexTTS dependencies", event="deps_failed", stage="bootstrap", code="INDEXTTS_DEPS_FAILED")
                 return None, None
    
    # Import
    try:
        if service == "qwen":
            # Assume we will implement qwen_tts_service
            from qwen_tts_service import run_qwen_tts, run_batch_qwen_tts
            _run_tts, _run_batch_tts = run_qwen_tts, run_batch_qwen_tts
            _loaded_tts_service = service
            return _run_tts, _run_batch_tts
        else:
            from tts import run_tts, run_batch_tts
            _run_tts, _run_batch_tts = run_tts, run_batch_tts
            _loaded_tts_service = service
            return _run_tts, _run_batch_tts
    except ImportError as e:
        log_error(logger, f"Failed to import TTS service {service}", event="tts_import_failed", stage="bootstrap", detail=str(e))
        return None, None



def analyze_video(file_path):
    try:
        probe = ffmpeg.probe(file_path)
        video_stream = next((stream for stream in probe['streams'] if stream['codec_type'] == 'video'), None)
        audio_stream = next((stream for stream in probe['streams'] if stream['codec_type'] == 'audio'), None)
        
        info = {
            "format_name": probe['format'].get('format_name'),
            "duration": float(probe['format'].get('duration', 0)),
            "video_codec": video_stream['codec_name'] if video_stream else None,
            "audio_codec": audio_stream['codec_name'] if audio_stream else None,
            "width": int(video_stream['width']) if video_stream else 0,
            "height": int(video_stream['height']) if video_stream else 0,
        }
        return {"success": True, "info": info}
    except Exception as e:
        return exception_result(
            "ANALYZE_VIDEO_FAILED",
            "视频信息分析失败",
            e,
            category="media",
            stage="analyze_video",
            retryable=True
        )

def transcode_video(input_path, output_path):
    log_business(logger, logging.INFO, "Starting video transcode", event="transcode_start", stage="transcode", detail=f"{input_path} -> {output_path}")
    try:
        stream = ffmpeg.input(input_path)
        stream = ffmpeg.output(stream, output_path, vcodec='libx264', acodec='aac', preset='fast', crf=23)
        ffmpeg.run(stream, overwrite_output=True, quiet=False)
        return {"success": True, "output": output_path}
    except ffmpeg.Error as e:
        err = e.stderr.decode() if e.stderr else str(e)
        log_error(logger, "Video transcode failed", event="transcode_failed", stage="transcode", detail=err, code="TRANSCODE_FAILED")
        return error_result(
            make_error(
                "TRANSCODE_FAILED",
                "视频转码失败",
                category="media",
                stage="transcode",
                retryable=False,
                detail=err
            )
        )
    except Exception as e:
        log_error(logger, "Video transcode failed with exception", event="transcode_exception", stage="transcode", detail=str(e), code="TRANSCODE_EXCEPTION")
        return exception_result(
            "TRANSCODE_EXCEPTION",
            "视频转码失败",
            e,
            category="system",
            stage="transcode",
            retryable=False
        )


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


def _run_dub_asr_stage(config, cache_dir):
    log_business(logger, logging.INFO, "Starting dub ASR stage", event="dub_step", stage="asr")
    emit_stage("dub_video", "asr", "正在识别字幕", stage_label="正在识别字幕")

    segments = run_asr(
        config.input_path,
        service=config.asr_service,
        output_dir=cache_dir,
        vad_onset=config.vad_onset,
        vad_offset=config.vad_offset,
        language=config.ori_lang
    )
    if not segments:
        emit_error_issue(
            "dub_video",
            make_error(
                "ASR_NO_SEGMENTS",
                "识别失败或未检测到有效语音",
                category="asr",
                stage="asr",
                retryable=True,
                suggestion="请调整源语言、VAD 阈值或更换 ASR 引擎后重试"
            )
        )
        return None
    return segments


def _run_dub_translation_stage(translator, segments, target_lang):
    log_business(logger, logging.INFO, "Starting dub translation stage", event="dub_step", stage="translate", detail=f"segments={len(segments)}")
    emit_stage("dub_video", "translate", f"正在翻译 {len(segments)} 个片段", stage_label="正在翻译字幕")

    source_texts = [seg.get("text", "") for seg in segments]
    translated_texts = translator.translate_batch(source_texts, target_lang)
    if len(translated_texts) != len(source_texts):
        print(f"[DubVideo] Translation batch length mismatch. Expected {len(source_texts)}, got {len(translated_texts)}")
        if len(translated_texts) < len(source_texts):
            translated_texts.extend(source_texts[len(translated_texts):])
        else:
            translated_texts = translated_texts[:len(source_texts)]
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

        print(f"  [{idx+1}/{len(segments)}] Translating: {original_text}")
        print(f"    -> {translated_text}")

        if not translated_text:
            print("    Skipping (Translation failed)")
            continue

        tts_tasks.append({
            "idx": idx,
            "translated_text": translated_text,
            "start": start,
            "duration": duration,
            "original_seg": seg
        })
    return tts_tasks


def _build_dub_tts_segments(tts_tasks, segments_dir):
    return [
        {
            "original_index": item["idx"],
            "start": item["start"],
            "end": item["start"] + item["duration"],
            "text": item["translated_text"],
            "source_text": item["original_seg"].get("text", ""),
            "audioPath": os.path.join(segments_dir, f"dub_{item['idx']}.wav")
        }
        for item in tts_tasks
    ]


def _align_dubbed_segment_if_needed(tts_output_path, duration, strategy, segment_index):
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


def _collect_dub_tts_results(tts_tasks, batch_tts_result, strategy):
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
            _align_dubbed_segment_if_needed(tts_output_path, duration, strategy, idx)
            new_audio_segments.append({
                "start": start,
                "path": tts_output_path,
                "duration": duration
            })
            result_segments.append({
                "index": idx,
                "start": start,
                "end": start + duration,
                "original_text": original_seg.get("text", ""),
                "text": translated_text,
                "audio_path": tts_output_path,
                "duration": duration,
                "success": True
            })
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
                suggestion="请查看完整日志或切换参考音频后重试"
            ),
            level="warn",
            item_index=idx + 1,
            item_total=len(tts_tasks)
        )
        result_segments.append({
            "index": idx,
            "start": start,
            "end": start + duration,
            "original_text": original_seg.get("text", ""),
            "text": translated_text,
            "audio_path": tts_output_path,
            "duration": duration,
            "success": False,
            "error": last_error or "TTS generation failed after retries"
        })

    return new_audio_segments, result_segments


def _merge_dub_video(config, new_audio_segments):
    log_business(logger, logging.INFO, "Starting dub merge stage", event="dub_step", stage="merge_video", detail=f"segments={len(new_audio_segments)}")
    emit_stage("dub_video", "merge_video", "正在合成视频", stage_label="正在合成视频")
    return merge_audios_to_video(
        config.input_path,
        new_audio_segments,
        config.output_path,
        strategy=config.strategy,
        audio_mix_mode=config.audio_mix_mode
    )

def translate_text(input_text_or_json, target_lang, **kwargs):
    """
    Translates text or a list of segments (JSON string).
    """
    action_name = "translate_text"
    LLMTranslator = get_llm_translator_class()
    translator = LLMTranslator(**kwargs)
    
    try:
        # Try to parse as JSON list of segments
        import json
        data = json.loads(input_text_or_json)
        
        if isinstance(data, list):
            # [Batch Mode for External API]
            if translator.use_external:
                print(f"Batch Translating {len(data)} segments via External API to {target_lang}...")
                
                # Extract texts
                texts_to_translate = [item.get('text', '') for item in data]
                
                # Perform Batch Translation
                translated_texts = translator.translate_batch(texts_to_translate, target_lang)
                
                # Reassemble
                translated_segments = []
                for i, item in enumerate(data):
                    new_item = item.copy()
                    # Safety check for length mismatch (handled in llm.py but good to be safe)
                    trans_text = translated_texts[i] if i < len(translated_texts) else item.get('text', '')
                    new_item['text'] = trans_text
                    translated_segments.append(new_item)
                    
                    # Optional: Print progress or debug?
                    # Batch is fast, maybe just print first/last or summary
                
                print(f"Batch translation complete. Processed {len(translated_segments)} segments.")
                translator.cleanup()
                return {"success": True, "segments": translated_segments}

            # [Original Loop for Local Model]
            print(f"Translating {len(data)} segments to {target_lang}...")
            emit_stage(
                action_name,
                "translate",
                f"正在翻译 {len(data)} 个片段到 {target_lang}",
                stage_label="正在翻译字幕"
            )
            translated_segments = []
            for idx, item in enumerate(data):
                original = item.get('text', '')
                if not original:
                    translated_segments.append(item)
                    continue
                    
                print(f"  [{idx+1}/{len(data)}] {original}")
                emit_progress(
                    action_name,
                    "translate",
                    int((idx + 1) / len(data) * 100),
                    f"第 {idx + 1}/{len(data)} 条翻译中",
                    stage_label="正在翻译字幕",
                    item_index=idx + 1,
                    item_total=len(data)
                )
                trans = translator.translate(original, target_lang)
                
                # Stream partial result
                partial_data = {
                    "index": idx,
                    "text": trans if trans else original
                }
                emit_partial_result(action_name, partial_data)
                
                new_item = item.copy()
                new_item['text'] = trans if trans else original
                translated_segments.append(new_item)
            
            translator.cleanup()
            return {"success": True, "segments": translated_segments}
        else:
            # Simple string
            trans = translator.translate(input_text_or_json, target_lang)
            translator.cleanup()
            return {"success": True, "text": trans}
            
    except json.JSONDecodeError:
        # Not JSON, treat as raw text
        # Not JSON, treat as raw text
        trans = translator.translate(input_text_or_json, target_lang)
        translator.cleanup()
        return {"success": True, "text": trans}
    except Exception as e:
        return exception_result(
            "TRANSLATE_FAILED",
            "翻译失败",
            e,
            category="translation",
            stage="translate",
            retryable=True
        )


# 333: 
def dub_video(input_path, target_lang, output_path, asr_service="whisperx", vad_onset=0.700, vad_offset=0.700, tts_service="indextts", **kwargs):
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
        kwargs=kwargs
    )
    cache_dir = None
    segments_dir = None
    
    # 0. Get TTS Runner (This will switch deps if needed)
    run_tts_func, run_batch_tts_func = get_tts_runner(config.tts_service)
    if not run_tts_func:
        backend_error = make_error(
            "TTS_INIT_FAILED",
            f"初始化 TTS 服务失败: {config.tts_service}",
            category="tts",
            stage="bootstrap",
            retryable=True,
            suggestion="请检查模型依赖、显卡环境或切换 TTS 引擎"
        )
        emit_error_issue("dub_video", backend_error)
        return error_result(backend_error)

    # 1. Initialize LLM
    LLMTranslator = get_llm_translator_class()
    translator = LLMTranslator(**config.translation.to_translator_kwargs())
    
    cache_dir, segments_dir = _prepare_dub_workspace(config)
    segments = _run_dub_asr_stage(config, cache_dir)
    if not segments:
        return error_result(
            make_error(
                "ASR_NO_SEGMENTS",
                "识别失败或未检测到有效语音",
                category="asr",
                stage="asr",
                retryable=True,
                suggestion="请调整源语言、VAD 阈值或更换 ASR 引擎后重试"
            )
        )
    
    print(f"DEBUG: Output Path: {config.output_path}")
    print(f"DEBUG: Segments Dir: {segments_dir}")
    print(f"DEBUG: Input Path: {config.input_path}")

    translated_texts = _run_dub_translation_stage(translator, segments, config.target_lang)
    tts_tasks = _build_dub_tts_tasks(segments, translated_texts)
        
    print("Translation done. Releasing LLM VRAM...", flush=True)
    translator.cleanup()
    del translator
    
    log_business(logger, logging.INFO, "Starting dub TTS stage", event="dub_step", stage="tts_generate", detail=f"segments={len(tts_tasks)} service={config.tts_service}")
    emit_stage("dub_video", "tts_generate", f"正在生成 {len(tts_tasks)} 条配音", stage_label="正在生成配音")

    tts_segments = _build_dub_tts_segments(tts_tasks, segments_dir)
    batch_runtime_kwargs = config.tts.to_runner_kwargs()
    batch_tts_result = generate_batch_tts_results(
        video_path=config.input_path,
        segments=tts_segments,
        work_dir=segments_dir,
        target_lang=config.target_lang,
        tts_service_name=config.tts_service,
        tts_kwargs=batch_runtime_kwargs,
        args_ref_audio=config.tts.ref_audio,
        explicit_qwen_ref_text=config.tts.qwen_ref_text or "",
        max_retry_attempts=config.dub_retry_attempts,
        get_tts_runner=get_tts_runner,
        get_audio_duration=get_audio_duration,
        ffmpeg=ffmpeg,
        librosa=librosa,
        sf=sf,
        log_prefix="[DubVideo]"
    )

    if not batch_tts_result.get("success"):
        return batch_tts_result

    new_audio_segments, result_segments = _collect_dub_tts_results(
        tts_tasks,
        batch_tts_result,
        config.strategy
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
                suggestion="可先导出日志，再对失败片段单独重试"
            ),
            level="warn"
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
                        suggestion="请先检查参考音频、TTS 引擎与显存状态，再重试失败片段"
                    )
                ),
                "failed_segments": failed_segments,
                "segments": result_segments
            }
        
    success = _merge_dub_video(config, new_audio_segments)
    
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
            "warning": f"Segments failed after retries: {', '.join(str(seg.get('index')) for seg in failed_segments)}" if failed_segments else None
        }
    else:
        backend_error = make_error(
            "MERGE_VIDEO_FAILED",
            "视频合成失败",
            category="merge",
            stage="merge_video",
            retryable=True,
            suggestion="请检查 FFmpeg、输出路径和完整日志"
        )
        emit_error_issue("dub_video", backend_error)
        return error_result(backend_error)

WORKER_RESULT_PREFIX = "__WORKER_RESULT__"


def execute_with_args(args):
    tts_kwargs = build_tts_kwargs(args)
    extra_kwargs = build_translation_kwargs(args)
    set_event_context(action=args.action)
    try:
        handled, basic_result = dispatch_basic_action(
            args,
            tts_kwargs,
            extra_kwargs,
            get_tts_runner=get_tts_runner,
            run_asr=run_asr,
            translate_text=translate_text,
            align_audio=align_audio,
            get_audio_duration=get_audio_duration,
            merge_audios_to_video=merge_audios_to_video,
            analyze_video=analyze_video,
            transcode_video=transcode_video,
            dub_video=dub_video
        )
        if handled:
            return basic_result

        if args.action == "generate_single_tts":
            result_data, _ = handle_generate_single_tts(
                args,
                tts_kwargs,
                get_tts_runner=get_tts_runner,
                get_audio_duration=get_audio_duration,
                align_audio=align_audio,
                ffmpeg=ffmpeg,
                librosa=librosa,
                sf=sf
            )
            return result_data

        if args.action == "generate_batch_tts":
            return handle_generate_batch_tts(
                args,
                tts_kwargs,
                get_tts_runner=get_tts_runner,
                get_audio_duration=get_audio_duration,
                ffmpeg=ffmpeg,
                librosa=librosa,
                sf=sf
            )

        if args.action == "prepare_reference_audio":
            result_data, _ = handle_prepare_reference_audio(
                args,
                ffmpeg=ffmpeg,
                librosa=librosa,
                sf=sf
            )
            return result_data

        log_error(logger, f"Unknown action: {args.action}", event="unknown_action", stage="dispatch", code="UNKNOWN_ACTION", retryable=False)
        return None
    finally:
        clear_event_context()


def run_worker_loop(base_args):
    parser = build_parser()
    log_business(logger, logging.INFO, "Backend worker started", event="worker_started", stage="worker")

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        request_id = None
        try:
            request_payload = json.loads(line)
            request_id = str(request_payload.get("id") or "")
            request_args = request_payload.get("args") or []
            if not isinstance(request_args, list):
                raise ValueError("Worker request args must be a list")

            parsed_args = parser.parse_args(base_args + ["--json"] + request_args)
            with scoped_event_context(trace_id=request_id or None, request_id=request_id or None):
                result = execute_with_args(parsed_args)
            response = {
                "id": request_id,
                "success": True,
                "result": result
            }
        except Exception as e:
            debug_log(f"Worker request failed: {e}")
            backend_error = make_error(
                "WORKER_REQUEST_FAILED",
                "后端工作线程请求执行失败",
                category="system",
                stage="worker",
                retryable=False,
                detail=str(e)
            )
            response = {
                "id": request_id,
                "success": False,
                "error": backend_error.message,
                "error_info": backend_error.to_payload()
            }

        _stdout_print(f"{WORKER_RESULT_PREFIX}{json.dumps(response, ensure_ascii=False)}", flush=True)


def main():
    setup_gpu_paths()

    parser = build_parser()
    args = parser.parse_args()
    cli_trace_id = f"cli:{args.action}"
    with scoped_event_context(trace_id=cli_trace_id, request_id=cli_trace_id):
        result_data = execute_with_args(args)

    if result_data is not None and args.json:
        _stdout_print("\n__JSON_START__\n")
        _stdout_print(json.dumps(result_data, indent=None, ensure_ascii=False))
        _stdout_print("\n__JSON_END__\n", flush=True)


if __name__ == "__main__":
    debug_log("Entering main block")
    worker_mode = "--worker" in sys.argv
    try:
        if worker_mode:
            base_args = []
            if "--model_dir" in sys.argv:
                idx = sys.argv.index("--model_dir")
                if idx + 1 < len(sys.argv):
                    base_args.extend(["--model_dir", sys.argv[idx + 1]])
            run_worker_loop(base_args)
        else:
            main()
    except Exception as e:
        import traceback
        err_msg = traceback.format_exc()
        debug_log(f"Unhandled Exception in main:\n{err_msg}")
        logger.error("Unhandled exception in main: %s", e)
        logger.error(err_msg)
        sys.exit(1)
        
    debug_log("Main finished normally")
    if not worker_mode:
        try:
            sys.stdout.close()
            sys.stderr.close()
        except:
            pass
        os._exit(0)
