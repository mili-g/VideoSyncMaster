import sys
import os
import torch
import soundfile as sf
import traceback
import json
import subprocess
from audio_validation import validate_generated_audio

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.append(BACKEND_DIR)

try:
    from dependency_manager import ensure_transformers_version
    ensure_transformers_version("4.52.1")
except ImportError:
    print("[IndexTTS] Dependency manager not found, skipping version check.")

try:
    from indextts.infer_v2 import IndexTTS2
except ImportError as e:
    print(f"Failed to import IndexTTS2: {e}")
    IndexTTS2 = None

# Default Checkpoint Paths
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
# 1. Dev: ../models/index-tts
PATH_DEV = os.path.join(BACKEND_DIR, "..", "models", "index-tts")
# 2. Prod: ../../models/index-tts
PATH_PROD = os.path.join(BACKEND_DIR, "..", "..", "models", "index-tts")

if os.path.exists(PATH_PROD):
    DEFAULT_MODEL_DIR = PATH_PROD
else:
    DEFAULT_MODEL_DIR = PATH_DEV
    
DEFAULT_CONFIG_PATH = os.path.join(DEFAULT_MODEL_DIR, "config.yaml")
INDEXTTS_ALLOWED_INFER_KWARGS = {
    "do_sample",
    "top_k",
    "top_p",
    "temperature",
    "repetition_penalty"
}


def _build_indextts_kwargs(text, kwargs):
    valid_kwargs = {
        key: value for key, value in (kwargs or {}).items()
        if key in INDEXTTS_ALLOWED_INFER_KWARGS
    }

    if 'do_sample' not in valid_kwargs:
        valid_kwargs['do_sample'] = True
    if 'top_k' not in valid_kwargs:
        valid_kwargs['top_k'] = 50
    if 'top_p' not in valid_kwargs:
        valid_kwargs['top_p'] = 1.0
    if 'temperature' not in valid_kwargs:
        valid_kwargs['temperature'] = 0.9

    text_len = len((text or '').strip())
    if text_len <= 12:
        valid_kwargs['top_k'] = min(int(valid_kwargs.get('top_k', 50)), 20)
        valid_kwargs['top_p'] = min(float(valid_kwargs.get('top_p', 1.0)), 0.85)
        valid_kwargs['temperature'] = min(float(valid_kwargs.get('temperature', 0.9)), 0.65)
        valid_kwargs['repetition_penalty'] = max(float(valid_kwargs.get('repetition_penalty', 1.0)), 1.12)
    elif text_len <= 32:
        valid_kwargs['top_k'] = min(int(valid_kwargs.get('top_k', 50)), 35)
        valid_kwargs['top_p'] = min(float(valid_kwargs.get('top_p', 1.0)), 0.92)
        valid_kwargs['temperature'] = min(float(valid_kwargs.get('temperature', 0.9)), 0.78)
        valid_kwargs['repetition_penalty'] = max(float(valid_kwargs.get('repetition_penalty', 1.0)), 1.08)

    return valid_kwargs


def _validate_indextts_duration(audio_path, text):
    info = sf.info(audio_path)
    dur = info.duration
    text_len = len((text or '').strip())

    if 29.8 < dur < 30.2 and text_len < 50:
        raise Exception(f"Generated audio is suspiciously long ({dur:.2f}s) for short text '{text[:20]}...'. Likely timeout/hallucination.")

    if dur > 60:
        raise Exception(f"Generated audio too long ({dur:.2f}s).")

    if text_len < 10 and dur > 15.0:
        raise Exception(f"Generated audio too long ({dur:.2f}s) for very short text '{text[:20]}...'.")

    if text_len < 24 and dur > 18.0:
        raise Exception(f"Generated audio too long ({dur:.2f}s) for short text '{text[:20]}...'.")

    return dur

def trim_silence(audio_path, output_path=None):
    """
    Trim silence from the beginning and end of the audio file using FFmpeg.
    """
    if not output_path:
        output_path = audio_path
        
    temp_path = audio_path.replace('.wav', '_trimmed_temp.wav')
    
    try:

        filter_str = "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB,areverse"
        
        cmd = [
            'ffmpeg', '-y', '-i', audio_path,
            '-af', filter_str,
            temp_path
        ]
        
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        if os.path.exists(temp_path) and os.path.getsize(temp_path) > 1000: # >1KB
            if os.path.exists(output_path) and output_path != audio_path:
                os.remove(output_path)
            # Move temp to output
            if output_path == audio_path:
                os.remove(audio_path)
                os.rename(temp_path, audio_path)
            else:
                os.rename(temp_path, output_path)
            return True
        else:
            print(f"[Trim] Warning: Trim resulted in empty file, keeping original. {audio_path}")
            if os.path.exists(temp_path): os.remove(temp_path)
            return False
            
    except Exception as e:
        print(f"[Trim] Error trimming silence: {e}")
        if os.path.exists(temp_path): 
            try: os.remove(temp_path)
            except: pass
        return False


def run_tts(text, ref_audio_path, output_path, model_dir=None, config_path=None, language="English", **kwargs):
    if IndexTTS2 is None:
        print("IndexTTS2 not available.")
        return False
    
    if model_dir is None:
        model_dir = DEFAULT_MODEL_DIR
    if config_path is None:
        config_path = DEFAULT_CONFIG_PATH
        
    print(f"Initializing IndexTTS2 from {model_dir}...")
    
    
    print(f"TTS Text with tag: {text}")
    

    
    try:
        tts = IndexTTS2(
            cfg_path=config_path, 
            model_dir=model_dir, 
            use_fp16=True, 
            use_cuda_kernel=False, 
            use_deepspeed=False
        )
        
        print(f"Synthesizing text: '{text}' using ref: {ref_audio_path}")
        
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        
        valid_kwargs = _build_indextts_kwargs(text, kwargs)

        # Explicitly pass advanced params if present in kwargs
        # (Though they are auto-passed by kwargs filter, we just ensure they are valid)

        tts.infer(
            spk_audio_prompt=ref_audio_path, 
            text=text, 
            output_path=output_path,
            verbose=True,
            **valid_kwargs
        )

        _validate_indextts_duration(output_path, text)

        is_valid, validation_info = validate_generated_audio(output_path)
        if not is_valid:
            print(f"[TTS] Generated audio rejected: {validation_info}")
            try:
                if os.path.exists(output_path):
                    os.remove(output_path)
            except Exception:
                pass
            return False
        
        print(f"TTS complete. Saved to {output_path}")
        return True
        
    except Exception as e:
        print(f"Error during TTS: {e}")
        import traceback
        traceback.print_exc()
        return False


def run_batch_tts(tasks, model_dir=None, config_path=None, language="English", **kwargs):
    """
    Run Batch Voice Cloning TTS.
    :param tasks: List of dicts {text, ref_audio_path, output_path}
    :param language: Default language for tasks if not specified in task item
    """
    if IndexTTS2 is None:
        print("IndexTTS2 not available.")
        # Fix: Yield error for each task so main.py knows it failed explicitly
        for task in tasks:
            yield {"success": False, "error": "IndexTTS2 not available: " + str(sys.modules.get('indextts.infer_v2', 'Unknown Import Error'))}
        return

    if model_dir is None:
        model_dir = DEFAULT_MODEL_DIR
    if config_path is None:
        config_path = DEFAULT_CONFIG_PATH

    print(f"Initializing IndexTTS2 (Batch) from {model_dir}...")
    
    # Retrieve batch size (default 1)
    batch_size = kwargs.get('batch_size', 1)
    
    try:
        # Initialize model once
        tts = IndexTTS2(
            cfg_path=config_path, 
            model_dir=model_dir, 
            use_fp16=True, 
            use_cuda_kernel=False, 
            use_deepspeed=False
        )
        
        total = len(tasks)
        
        for i, task in enumerate(tasks):
            text = task['text']
            ref = task['ref_audio_path']
            out = task['output_path']
            
            # Use task-specific language or fallback to global default
            task_lang = task.get('language', language)
            

            print(f"Synthesizing [{i+1}/{total}]: '{text}'")
            
            os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
            
            try:
                valid_kwargs = _build_indextts_kwargs(text, kwargs)
                
                tts.infer(
                    spk_audio_prompt=ref, 
                    text=text, 
                    output_path=out,
                    verbose=False,
                    **valid_kwargs
                )

                
                try:
                    dur = _validate_indextts_duration(out, text)
                except Exception as e_valid:
                     print(f"[BatchTTS] Validation failed for {out}: {e_valid}")
                     raise e_valid

                is_valid, validation_info = validate_generated_audio(out)
                if not is_valid:
                    raise Exception(f"Generated audio rejected: {validation_info}")

                # Emit Partial Result for UI to enable playback immediately
                partial_data = {
                    "index": task.get('index', i),
                    "audio_path": out,
                    "success": True,
                    "duration": dur
                }
                print(f"[PARTIAL] {json.dumps(partial_data)}", flush=True)
                
                yield {
                    "index": task.get('index', i),
                    "success": True,
                    "audio_path": out,
                    "duration": dur
                }

            except Exception as e:
                print(f"Failed task {i}: {e}")
                
                # Include audio_path if file was generated (allows user to play even failed audio)
                error_result = {
                    "index": task.get('index', i),
                    "success": False,
                    "error": str(e)
                }
                
                # Check if audio file exists despite the error
                if os.path.exists(out):
                    error_result["audio_path"] = out
                    try:
                        info = sf.info(out)
                        error_result["duration"] = info.duration
                    except:
                        pass
                
                print(f"[PARTIAL] {json.dumps(error_result)}", flush=True)
                
                yield error_result
            
            # Emit progress
            print(f"[PROGRESS] {int((i + 1) / total * 100)}", flush=True)

    except Exception as e:
        print(f"Error during Batch TTS: {e}")
        import traceback
        traceback.print_exc()
        pass
    finally:
        if IndexTTS2 is not None:
            pass
        
        if 'tts' in locals():
            del tts
        
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            print("[BatchTTS] VRAM cleared.")

