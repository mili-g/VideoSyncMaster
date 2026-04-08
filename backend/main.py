import sys
import os
# import torch # Moved to inside main/functions for safety
import pathlib

# FORCE IMMEDIATE FLUSH
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
print("DEBUG: Pre-import check passed", file=sys.stderr, flush=True)

# [USER REQUEST] Force Offline for manual handling of models
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ["PYTHONUTF8"] = "1"

# Force UTF-8 for stdout/stderr
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


import subprocess

current_script_dir = os.path.dirname(os.path.abspath(__file__))
if current_script_dir not in sys.path:
    sys.path.insert(0, current_script_dir)

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
# With flat structure, APP_ROOT is consistently the parent of backend/
APP_ROOT = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
# Detect production by checking for app.asar (typically in resources/) or if sys is frozen
IS_PROD = os.path.exists(os.path.join(APP_ROOT, "resources", "app.asar")) or getattr(sys, 'frozen', False)

# Logging to "logs" folder in App Root (or Project Root)
log_dir = os.path.join(APP_ROOT, "logs")
log_file = os.path.join(log_dir, "backend_debug.log")

try:
    if not os.path.exists(log_dir):
        os.makedirs(log_dir, exist_ok=True)
        
    def debug_log(msg):
        try:
            with open(log_file, "a", encoding="utf-8") as f:
                import datetime
                ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                f.write(f"[{ts}] {msg}\n")
        except:
            print(f"Log Error: {msg}")

    debug_log("Backend starting...")
    debug_log(f"Executable: {sys.executable}")
    debug_log(f"CWD: {os.getcwd()}")
    debug_log(f"App Root: {APP_ROOT}")
    debug_log(f"Is Prod: {IS_PROD}")

except Exception as e:
    print(f"Logging setup failed: {e}")
    # Fallback logger
    def debug_log(msg):
        print(f"[LOG_FAIL] {msg}")

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
                print(f"[BOOTSTRAP] Relaunching with portable python: {target_py}")
                # Ensure we pass all original arguments
                cmd = [target_py, __file__] + sys.argv[1:]
                
                # Pass environment but ensure PATH includes python Scripts/Lib (optional, but good)
                env = os.environ.copy()
                
                # Execute
                ret = subprocess.call(cmd, env=env)
                sys.exit(ret)
                
    except Exception as e:
        print(f"[BOOTSTRAP WARNING] Failed to enforce portable python: {e}")

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

if log_file:
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
    print(f"[WARNING] Model directory not found: {MODELS_HUB_DIR}", file=sys.stderr)
    print(f"[WARNING] Local WhisperX models will be unavailable. API-based services (Jianying/Bcut) can still be used.", file=sys.stderr)
    # Don't exit, allow startup for API usage
    # sys.exit(1)
    
log_location = f"Models found at: {MODELS_HUB_DIR}"
print(log_location)

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
    print(f"Using portable FFmpeg from: {ffmpeg_bin}")
    os.environ["PATH"] = ffmpeg_bin + os.pathsep + os.environ["PATH"]
else:
    print("Portable FFmpeg not found, using system PATH.")

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
        print(f"[WARNING] Failed to patch DLL paths: {e}")


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
            print("[Main] Ensuring dependencies for Qwen3-TTS...")
            setup_gpu_paths()
            if ensure_transformers_version("4.57.3"):
                 check_gpu_deps()
                 print("[Main] Qwen3 dependencies ready.")
            else:
                 print("[Main] Failed to setup Qwen3 dependencies.")
                 return None, None
        else:
            # Default/IndexTTS
            print("[Main] Ensuring dependencies for IndexTTS...")
            if ensure_transformers_version("4.52.1"):
                 print("[Main] IndexTTS dependencies ready.")
            else:
                 print("[Main] Failed to setup IndexTTS dependencies.")
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
        print(f"[Main] Failed to import TTS service {service}: {e}")
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
        return {"success": False, "error": str(e)}

def transcode_video(input_path, output_path):
    print(f"Transcoding {input_path} to {output_path}...")
    try:
        stream = ffmpeg.input(input_path)
        stream = ffmpeg.output(stream, output_path, vcodec='libx264', acodec='aac', preset='fast', crf=23)
        ffmpeg.run(stream, overwrite_output=True, quiet=False)
        return {"success": True, "output": output_path}
    except ffmpeg.Error as e:
        err = e.stderr.decode() if e.stderr else str(e)
        print(f"Transcoding failed: {err}")
        return {"success": False, "error": err}
    except Exception as e:
        print(f"Transcoding failed: {e}")
        return {"success": False, "error": str(e)}

def translate_text(input_text_or_json, target_lang, **kwargs):
    """
    Translates text or a list of segments (JSON string).
    """
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
            translated_segments = []
            for idx, item in enumerate(data):
                original = item.get('text', '')
                if not original:
                    translated_segments.append(item)
                    continue
                    
                print(f"  [{idx+1}/{len(data)}] {original}")
                print(f"[PROGRESS] {int((idx + 1) / len(data) * 100)}", flush=True)
                trans = translator.translate(original, target_lang)
                
                # Stream partial result
                partial_data = {
                    "index": idx,
                    "text": trans if trans else original
                }
                print(f"[PARTIAL] {json.dumps(partial_data)}", flush=True)
                
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
        return {"success": False, "error": str(e)}


# 333: 
def dub_video(input_path, target_lang, output_path, asr_service="whisperx", vad_onset=0.700, vad_offset=0.700, tts_service="indextts", **kwargs):
    print(f"Starting AI Dubbing for {input_path} -> {target_lang} using ASR:{asr_service} TTS:{tts_service}", flush=True)
    
    # 0. Get TTS Runner (This will switch deps if needed)
    run_tts_func, run_batch_tts_func = get_tts_runner(tts_service)
    if not run_tts_func:
        return {"success": False, "error": f"Failed to initialize TTS service: {tts_service}"}

    # 1. Initialize LLM
    translator_kwargs = {
        "model_dir": kwargs.get("model_dir"),
        "api_key": kwargs.get("api_key"),
        "base_url": kwargs.get("base_url"),
        "model": kwargs.get("model")
    }
    LLMTranslator = get_llm_translator_class()
    translator = LLMTranslator(**translator_kwargs)
    
    # 2. Run ASR
    print("Step 1/4: Running ASR...", flush=True)
    
    output_dir_root = os.path.dirname(output_path)
    basename = os.path.splitext(os.path.basename(output_path))[0]
    segments_dir = os.path.join(output_dir_root, f"{basename}_segments") 
    
    
    cache_dir = os.path.join(output_dir_root, ".cache")
    if not os.path.exists(cache_dir):
        os.makedirs(cache_dir)
        
    segments = run_asr(
        input_path,
        service=asr_service,
        output_dir=cache_dir,
        vad_onset=vad_onset,
        vad_offset=vad_offset,
        language=kwargs.get("ori_lang")
    ) 
    if not segments:
        return {"success": False, "error": "ASR failed or no speech detected."}
    
    
    output_dir = os.path.dirname(output_path)
    basename = os.path.splitext(os.path.basename(output_path))[0]
    segments_dir = os.path.join(output_dir, f"{basename}_segments")
    
    print(f"DEBUG: Output Path: {output_path}")
    print(f"DEBUG: Segments Dir: {segments_dir}")
    print(f"DEBUG: Input Path: {input_path}")
    
    if os.path.exists(segments_dir):
        shutil.rmtree(segments_dir)
    os.makedirs(segments_dir)

    new_audio_segments = []
    result_segments = [] 
    
    
    print(f"Step 2: Translating {len(segments)} segments...", flush=True)
    source_texts = [seg.get('text', '') for seg in segments]
    translated_texts = translator.translate_batch(source_texts, target_lang)
    if len(translated_texts) != len(source_texts):
        print(f"[DubVideo] Translation batch length mismatch. Expected {len(source_texts)}, got {len(translated_texts)}")
        if len(translated_texts) < len(source_texts):
            translated_texts.extend(source_texts[len(translated_texts):])
        else:
            translated_texts = translated_texts[:len(source_texts)]

    tts_tasks = []
    for idx, seg in enumerate(segments):
        original_text = seg['text']
        start = seg['start']
        end = seg['end']
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
        
    print("Translation done. Releasing LLM VRAM...", flush=True)
    translator.cleanup()
    del translator
    
    print(f"Step 3: Cloning Voice for {len(tts_tasks)} segments using {tts_service}...", flush=True)

    tts_segments = [
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

    batch_runtime_kwargs = dict(kwargs)
    batch_runtime_kwargs["batch_size"] = int(batch_runtime_kwargs.get("batch_size") or 1)
    batch_tts_result = generate_batch_tts_results(
        video_path=input_path,
        segments=tts_segments,
        work_dir=segments_dir,
        target_lang=target_lang,
        tts_service_name=tts_service,
        tts_kwargs=batch_runtime_kwargs,
        args_ref_audio=kwargs.get("ref_audio"),
        explicit_qwen_ref_text=kwargs.get("qwen_ref_text", "") or "",
        max_retry_attempts=int(kwargs.get("dub_retry_attempts", 3) or 3),
        get_tts_runner=get_tts_runner,
        get_audio_duration=get_audio_duration,
        ffmpeg=ffmpeg,
        librosa=librosa,
        sf=sf,
        log_prefix="[DubVideo]"
    )

    if not batch_tts_result.get("success"):
        return batch_tts_result

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
            should_align = True
            strategy = kwargs.get('strategy', 'auto_speedup')
            if strategy in ['frame_blend', 'freeze_frame', 'rife']:
                should_align = False
                print(f"    [DubVideo] Strategy is {strategy}, skipping audio alignment.")

            if duration > 0 and should_align and tts_output_path:
                try:
                    current_dur = get_audio_duration(tts_output_path)
                    if current_dur and current_dur > duration + 0.1:
                        print(f"    [DubVideo] Segment {idx} duration {current_dur:.2f}s > {duration:.2f}s. Aligning...")
                        temp_aligned = tts_output_path.replace('.wav', '_aligned_temp.wav')
                        if align_audio(tts_output_path, temp_aligned, duration):
                            try:
                                if os.path.exists(tts_output_path):
                                    os.remove(tts_output_path)
                                os.rename(temp_aligned, tts_output_path)
                                print(f"    [DubVideo] Aligned and overwritten: {tts_output_path}")
                            except Exception as e:
                                print(f"    [DubVideo] Failed to overwrite aligned file: {e}")
                except Exception as e:
                    print(f"    [DubVideo] Auto-align warning: {e}")

            new_audio_segments.append({
                'start': start,
                'path': tts_output_path,
                'duration': duration
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
        else:
            print(f"    [DubVideo] Segment {idx} failed after retries: {last_error}")
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

    failed_segments = [seg for seg in result_segments if seg.get("success") is False]
    if failed_segments:
        failed_indexes = [str(seg.get("index")) for seg in failed_segments]
        print(f"[DubVideo] Warning: segments still failed after retries: {', '.join(failed_indexes)}")
        if not new_audio_segments:
            return {
                "success": False,
                "error": f"All TTS segments failed after retries: {', '.join(failed_indexes)}",
                "failed_segments": failed_segments,
                "segments": result_segments
            }
        
    # 4. Merge
    print("Step 4/4: Merging Video...")
    success = merge_audios_to_video(
        input_path,
        new_audio_segments,
        output_path,
        strategy=kwargs.get('strategy', 'auto_speedup'),
        audio_mix_mode=kwargs.get('audio_mix_mode', 'preserve_background')
    )
    
    if success:
        return {
            "success": True, 
            "output": output_path, 
            "segments": result_segments,
            "failed_segments": failed_segments,
            "partial_success": len(failed_segments) > 0,
            "warning": f"Segments failed after retries: {', '.join(str(seg.get('index')) for seg in failed_segments)}" if failed_segments else None
        }
    else:
        return {"success": False, "error": "Merging failed."}



def main():
    # Setup GPU paths early to prevent DLL load errors
    setup_gpu_paths()

    parser = build_parser()
    args = parser.parse_args()
    tts_kwargs = build_tts_kwargs(args)
    extra_kwargs = build_translation_kwargs(args)

    result_data = None

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
        result_data = basic_result
    elif args.action == "generate_single_tts":
        result_data, should_return = handle_generate_single_tts(
            args,
            tts_kwargs,
            get_tts_runner=get_tts_runner,
            get_audio_duration=get_audio_duration,
            align_audio=align_audio,
            ffmpeg=ffmpeg,
            librosa=librosa,
            sf=sf
        )
        if should_return:
            return
    elif args.action == "generate_batch_tts":
        result_data = handle_generate_batch_tts(
            args,
            tts_kwargs,
            get_tts_runner=get_tts_runner,
            get_audio_duration=get_audio_duration,
            ffmpeg=ffmpeg,
            librosa=librosa,
            sf=sf
        )
    elif args.action == "prepare_reference_audio":
        result_data, should_return = handle_prepare_reference_audio(
            args,
            ffmpeg=ffmpeg,
            librosa=librosa,
            sf=sf
        )
        if should_return:
            return
    else:
        print(f"Unknown action: {args.action}")

    if result_data is not None and args.json:
        print("\n__JSON_START__\n")
        print(json.dumps(result_data, indent=None)) # Compact JSON
        print("\n__JSON_END__\n", flush=True) # Ensure flush so UI receives it immediately

    try:
        if args.action == 'asr':
            debug_log(f"Running ASR on: {args.input}")
            # Setup GPU environment lazily
            setup_gpu_paths()
            # Pass output_dir if provided
            result_data = run_asr(args.input, args.model, service=args.asr, output_dir=args.output_dir)
        elif args.action == 'translate_text':
             pass 
             
    except Exception as e:
        debug_log(f"CRITICAL ERROR: {e}")
        import traceback
        debug_log(traceback.format_exc())
        raise e



if __name__ == "__main__":
    debug_log("Entering main block")
    try:
        main()
    except Exception as e:
        import traceback
        err_msg = traceback.format_exc()
        debug_log(f"Unhandled Exception in main:\n{err_msg}")
        print(f"ERROR: {e}", file=sys.stderr)
        print(err_msg, file=sys.stderr)
        sys.exit(1)
        
    debug_log("Main finished normally")
    print("Force exiting...")
    try:
        sys.stdout.close()
        sys.stderr.close()
    except:
        pass
    os._exit(0)
