import os
import sys
import torch
import soundfile as sf
import traceback
import json
import shutil
import types
from audio_validation import validate_generated_audio
from event_protocol import emit_issue, emit_partial_result, emit_progress, emit_stage
from gpu_runtime import choose_adaptive_batch_size, format_gpu_snapshot


def _setup_portable_audio_tools():
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    candidate_bins = [
        os.path.join(backend_dir, "ffmpeg", "bin"),
        os.path.join(backend_dir, "sox"),
        os.path.join(backend_dir, "sox", "bin"),
    ]

    current_path = os.environ.get("PATH", "")
    for candidate in candidate_bins:
        if os.path.isdir(candidate) and candidate not in current_path:
            os.environ["PATH"] = candidate + os.pathsep + os.environ.get("PATH", "")


def _patch_transformers_auto_docstring():
    try:
        import transformers.utils as transformers_utils
    except Exception as error:
        print(f"[QwenTTS] Warning: Failed to import transformers.utils for docstring patch: {error}")
        return

    original = getattr(transformers_utils, "auto_docstring", None)
    if original is None or getattr(original, "_videosync_noop_patch", False):
        return

    def _noop_auto_docstring(obj=None, **_kwargs):
        if obj is None:
            def _decorator(inner_obj):
                return inner_obj
            return _decorator
        return obj

    _noop_auto_docstring._videosync_noop_patch = True  # type: ignore[attr-defined]
    transformers_utils.auto_docstring = _noop_auto_docstring
    print("[QwenTTS] Patched transformers.utils.auto_docstring for qwen_tts compatibility.")


def _install_sox_stub():
    if "sox" in sys.modules:
        return

    try:
        import numpy as _np
    except Exception as error:
        print(f"[QwenTTS] Warning: Failed to prepare SoX stub: {error}")
        return

    sox_module = types.ModuleType("sox")

    class _Transformer:
        def __init__(self):
            self._target_db = -6.0

        def norm(self, db_level=-6):
            self._target_db = float(db_level)
            return self

        def build_array(self, input_array, sample_rate_in=16000):
            wav = _np.asarray(input_array, dtype=_np.float32).copy()
            peak = float(_np.max(_np.abs(wav))) if wav.size > 0 else 0.0
            if peak <= 1e-8:
                return wav
            target_peak = float(10 ** (self._target_db / 20.0))
            gain = target_peak / peak
            wav *= gain
            return _np.clip(wav, -1.0, 1.0)

    sox_module.Transformer = _Transformer
    sox_module.NO_SOX = False
    sox_module.__dict__["__version__"] = "videosync-stub"
    sys.modules["sox"] = sox_module
    print("[QwenTTS] Installed in-process SoX stub for qwen_tts compatibility.")


def _patch_qwen_tts_sox_dependency():
    try:
        from qwen_tts.core.tokenizer_25hz.vq.speech_vq import (
            MelSpectrogramFeatures,
            XVectorExtractor,
        )
        import onnxruntime
        import torch.nn.functional as F
        import torchaudio.compliance.kaldi as kaldi
        import copy as _copy
        import numpy as _np
        import torch as _torch
    except Exception as error:
        print(f"[QwenTTS] Warning: Failed to patch qwen_tts SoX dependency: {error}")
        return

    if getattr(XVectorExtractor, "_videosync_sox_patch", False):
        return

    def _patched_init(self, audio_codec_with_xvector):
        option = onnxruntime.SessionOptions()
        option.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
        option.intra_op_num_threads = 1
        providers = ["CPUExecutionProvider"]
        self.ort_session = onnxruntime.InferenceSession(
            audio_codec_with_xvector,
            sess_options=option,
            providers=providers
        )
        self.mel_ext = MelSpectrogramFeatures(
            filter_length=1024,
            hop_length=160,
            win_length=640,
            n_mel_channels=80,
            mel_fmin=0,
            mel_fmax=8000,
            sampling_rate=16000
        )

    def _patched_sox_norm(self, audio):
        wav = _np.asarray(audio, dtype=_np.float32).copy()
        peak = float(_np.max(_np.abs(wav))) if wav.size > 0 else 0.0
        if peak <= 1e-8:
            return wav
        target_peak = float(10 ** (-6.0 / 20.0))
        gain = target_peak / peak
        wav *= gain
        wav = _np.clip(wav, -1.0, 1.0)
        return wav

    def _patched_extract_code(self, audio):
        with _torch.no_grad():
            norm_audio = self.sox_norm(audio)
            norm_audio = _torch.from_numpy(_copy.deepcopy(norm_audio)).unsqueeze(0)
            feat = kaldi.fbank(
                norm_audio,
                num_mel_bins=80,
                dither=0,
                sample_frequency=16000
            )
            feat = feat - feat.mean(dim=0, keepdim=True)
            norm_embedding = self.ort_session.run(
                None,
                {self.ort_session.get_inputs()[0].name: feat.unsqueeze(dim=0).cpu().numpy()}
            )[0].flatten()
            norm_embedding = F.normalize(_torch.from_numpy(norm_embedding), dim=0)
            ref_mel = self.mel_ext.extract(audio=norm_audio)
        return norm_embedding.numpy(), ref_mel.permute(0, 2, 1).squeeze(0).numpy()

    XVectorExtractor.__init__ = _patched_init
    XVectorExtractor.sox_norm = _patched_sox_norm
    XVectorExtractor.extract_code = _patched_extract_code
    XVectorExtractor._videosync_sox_patch = True
    print("[QwenTTS] Patched qwen_tts XVectorExtractor to avoid external SoX dependency.")


_setup_portable_audio_tools()

# Ensure environment requirements
try:
    from dependency_manager import ensure_transformers_version
    ensure_transformers_version("4.57.3")
except ImportError:
    print("[QwenTTS] Dependency manager not found, skipping version check.")

_patch_transformers_auto_docstring()
_install_sox_stub()

# Ensure qwen-tts can be imported
try:
    from qwen_tts import Qwen3TTSModel
    _patch_qwen_tts_sox_dependency()
except ImportError:
    Qwen3TTSModel = None
    print("[QwenTTS] Error: qwen-tts package not installed.")

# Global Model Cache
# { 'model_type': model_instance }
# types: 'VoiceDesign', 'Base', 'CustomVoice'
_loaded_models = {}
QWEN_ALLOWED_GENERATION_KWARGS = {
    "pad_token_id",
    "max_new_tokens",
    "temperature",
    "top_p",
    "repetition_penalty",
    "do_sample"
}


def _preview_text(text, limit=48):
    text = str(text or "").replace("\n", " ").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + "..."


def _compute_adaptive_max_new_tokens(text, requested_max_new_tokens, duration=None):
    requested = int(requested_max_new_tokens or 4096)
    text_len = len(str(text or "").strip())

    if duration is not None:
        try:
            duration = float(duration)
        except Exception:
            duration = None

    if text_len <= 12:
        adaptive_cap = 768
    elif text_len <= 32:
        adaptive_cap = 1024
    elif text_len <= 80:
        adaptive_cap = 1536
    elif text_len <= 160:
        adaptive_cap = 2048
    else:
        adaptive_cap = 2560

    if duration is not None:
        if duration <= 2.5:
            adaptive_cap = min(adaptive_cap, 1024)
        elif duration <= 5.0:
            adaptive_cap = min(adaptive_cap, 1536)
        elif duration <= 8.0:
            adaptive_cap = min(adaptive_cap, 2048)

    return max(512, min(requested, adaptive_cap))


def _build_qwen_generation_kwargs(kwargs, *, text="", duration=None, adaptive_max_new_tokens=False):
    gen_kwargs = {}
    real_model = kwargs.get("_real_model")
    pad_id = 2150

    if real_model:
        if hasattr(real_model, "generation_config") and getattr(real_model.generation_config, "pad_token_id", None) is not None:
            pad_id = real_model.generation_config.pad_token_id
        elif hasattr(real_model, "config") and getattr(real_model.config, "pad_token_id", None) is not None:
            pad_id = real_model.config.pad_token_id

    gen_kwargs["pad_token_id"] = int(pad_id)

    requested_max_new_tokens = int(kwargs.get("max_new_tokens", 4096))
    if adaptive_max_new_tokens:
        gen_kwargs["max_new_tokens"] = _compute_adaptive_max_new_tokens(text, requested_max_new_tokens, duration)
    else:
        gen_kwargs["max_new_tokens"] = requested_max_new_tokens

    if "temperature" in kwargs:
        gen_kwargs["temperature"] = float(kwargs["temperature"])
    else:
        gen_kwargs["temperature"] = 0.7

    if "top_p" in kwargs:
        gen_kwargs["top_p"] = float(kwargs["top_p"])
    else:
        gen_kwargs["top_p"] = 0.8

    if "repetition_penalty" in kwargs:
        gen_kwargs["repetition_penalty"] = float(kwargs["repetition_penalty"])
    else:
        gen_kwargs["repetition_penalty"] = 1.0

    if kwargs.get("do_sample"):
        gen_kwargs["do_sample"] = True

    return {key: value for key, value in gen_kwargs.items() if key in QWEN_ALLOWED_GENERATION_KWARGS}

def get_model(model_type, model_size="1.7B", device="cuda"):
    """
    Lazy load models.
    model_type: 'VoiceDesign', 'Base', 'CustomVoice'
    model_size: '1.7B' or '0.6B'
    """
    global _loaded_models
    
    if Qwen3TTSModel is None:
        raise ImportError("qwen-tts package not found")

    # Cache key needs to include size
    cache_key = f"{model_type}_{model_size}"
    if cache_key in _loaded_models:
        return _loaded_models[cache_key]
    
    print(f"[QwenTTS] Loading model: {model_type} ({model_size})...")
    
    # Check Local Path First
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(backend_dir)
    models_dir = os.path.join(project_root, "models")
    
    # Folder name convention: Qwen3-TTS-12Hz-{size}-{type}
    # e.g. Qwen3-TTS-12Hz-1.7B-VoiceDesign
    model_dir_name = f"Qwen3-TTS-12Hz-{model_size}-{model_type}"
    local_model_path = os.path.join(models_dir, model_dir_name)
    
    if os.path.exists(local_model_path):
        print(f"[QwenTTS] Found local model at: {local_model_path}")
        repo_id = local_model_path
    else:
        print(f"[QwenTTS] Local model not found at {local_model_path}, trying HF Hub...")
        repo_id = f"Qwen/Qwen3-TTS-12Hz-{model_size}-{model_type}"
    
    first_attempt_kwargs = {
        "device_map": device,
        "dtype": torch.bfloat16,
        "attn_implementation": "flash_attention_2"
    }

    model = None
    try:
        print(f"[QwenTTS] Attempting to load with Flash Attention 2...")
        model = Qwen3TTSModel.from_pretrained(repo_id, **first_attempt_kwargs)
        _loaded_models[cache_key] = model
        print(f"[QwenTTS] Loaded {model_type} ({model_size}) successfully (FA2).")
    except Exception as e:
        error_str = str(e)
        if "flash_attn" in error_str or "FlashAttention2" in error_str:
            print(f"[QwenTTS] Flash Attention 2 failed to load ({e}). Falling back to standard attention...")
            # Fallback to standard attention (sdpa or eager)
            try:
                # Try SDPA first (Torch 2.0+)
                fallback_kwargs = {
                    "device_map": device,
                    "dtype": torch.bfloat16,
                    "attn_implementation": "sdpa" 
                }
                model = Qwen3TTSModel.from_pretrained(repo_id, **fallback_kwargs)
                _loaded_models[cache_key] = model
                print(f"[QwenTTS] Loaded {model_type} ({model_size}) successfully (SDPA).")
            except Exception as e2:
                 print(f"[QwenTTS] SDPA failed ({e2}). Falling back to default (eager)...")
                 # Last resort: Eager execution, maybe float16 if bfloat16 is the issue (but usually it's attn)
                 fallback_kwargs_2 = {
                    "device_map": device,
                    "dtype": torch.float16 # Switch to float16 just in case
                }
                 model = Qwen3TTSModel.from_pretrained(repo_id, **fallback_kwargs_2)
                 _loaded_models[cache_key] = model
                 print(f"[QwenTTS] Loaded {model_type} ({model_size}) successfully (Eager/FP16).")
        else:
             print(f"[QwenTTS] Failed to load {model_type}: {e}")
             raise e
             
    # Post-load verification
    if model:
        # Resolve 'pad_token_id' warning/hang
        # Force set it unconditionally to ensure it sticks
        # Qwen3TTSModel wraps the actual HF model in .model attribute
        
        real_model = getattr(model, 'model', None)
        if real_model:
             found_eos = None
             # Try generation_config first
             if hasattr(real_model, 'generation_config') and real_model.generation_config.eos_token_id is not None:
                 found_eos = real_model.generation_config.eos_token_id
             
             # Try config second
             if found_eos is None and hasattr(real_model, 'config') and hasattr(real_model.config, 'eos_token_id'):
                 found_eos = real_model.config.eos_token_id
             
             # Hard fallback for Qwen3-TTS 1.7B Base (known ID)
             if found_eos is None:
                 print("[QwenTTS] Warning: eos_token_id not found in config. Using fallback ID 2150.")
                 found_eos = 2150

             if found_eos is not None:
                  # Set it everywhere to be safe
                  if hasattr(real_model, 'generation_config'):
                       real_model.generation_config.pad_token_id = found_eos
                       real_model.generation_config.eos_token_id = found_eos # Ensure consistent
                  
                  if hasattr(real_model, 'config'):
                       real_model.config.pad_token_id = found_eos
                       
                  print(f"[QwenTTS] Set pad_token_id to {found_eos}.")
             else:
                  print("[QwenTTS] CRITICAL: Could not determine valid eos/pad token id.")
        else:
             print(f"[QwenTTS] Warning: Structure mismatch. model.model type: {type(getattr(model, 'model', None))}")
                 
    return model

def run_qwen_tts(text, ref_audio_path, output_path, language="Auto", **kwargs):
    """
    Unified entry point for Single TTS generation.
    Handles 'design', 'clone', 'preset' modes.
    
    kwargs: qwen_mode, voice_instruct, preset_voice, qwen_ref_text, etc.
    """
    mode = kwargs.get('qwen_mode', 'clone')
    model_size = kwargs.get('qwen_model_size', '1.7B')
    print(f"[QwenTTS] Mode: {mode}, Size: {model_size}, Text: {text[:20]}...")
    
    def _validate_or_cleanup(path):
        is_valid, validation_info = validate_generated_audio(path)
        if not is_valid:
            print(f"[QwenTTS] Generated audio rejected: {validation_info}")
            try:
                if os.path.exists(path):
                    os.remove(path)
            except Exception:
                pass
            return False
        return True

    def _generate_preset_fallback():
        speaker = kwargs.get('preset_voice', 'Vivian')
        print(f"[QwenTTS] Falling back to preset voice: {speaker}")
        model = get_model("CustomVoice", model_size=model_size)
        wavs, sr = model.generate_custom_voice(
            text=text,
            language=language,
            speaker=speaker
        )
        sf.write(output_path, wavs[0], sr)
        return _validate_or_cleanup(output_path)

    try:
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        
        # 1. Voice Design Mode
        if mode == 'design':
            instruct = kwargs.get('voice_instruct', '')
            if not instruct:
                print("[QwenTTS] Warning: No voice instruction provided for Design mode.")
            
            model = get_model("VoiceDesign", model_size=model_size)
            
            print(f"[QwenTTS] Generating Voice Design with Instruct: {instruct[:30]}...")
            
            # generate_voice_design(text, language, instruct)
            wavs, sr = model.generate_voice_design(
                text=text,
                language=language,
                instruct=instruct
            )
            
            # Save
            sf.write(output_path, wavs[0], sr)
            if not _validate_or_cleanup(output_path):
                return False
            print(f"[QwenTTS] Saved to {output_path}")
            return True

        # 2. Custom Voice Mode (Preset)
        elif mode == 'preset':
            speaker = kwargs.get('preset_voice', 'Vivian')
            print(f"[QwenTTS] Generating Preset Voice: {speaker}...")
            
            # Using CustomVoice model type for preset speakers
            model = get_model("CustomVoice", model_size=model_size)
            
            wavs, sr = model.generate_custom_voice(
                text=text,
                language=language,
                speaker=speaker
            )
            
            sf.write(output_path, wavs[0], sr)
            if not _validate_or_cleanup(output_path):
                return False
            print(f"[QwenTTS] Saved to {output_path}")
            return True

        # 3. Clone Mode (Base)
        elif mode == 'clone':
            # Check if this is actually a "Design -> Clone" handoff
            # In "Design" flow, the user might pass the DESIGNED audio as ref_audio_path
            
            ref_text = kwargs.get('qwen_ref_text', '')
            
            x_vector_mode = False
            if not ref_text:
                print("[QwenTTS] No reference text provided. Using x-vector only mode (lower quality).")
                x_vector_mode = True
            
            if not ref_audio_path or not os.path.exists(ref_audio_path):
                print(f"[QwenTTS] Error: Ref audio not found: {ref_audio_path}")
                return _generate_preset_fallback()
                
            model = get_model("Base", model_size=model_size)
            
            print(f"[QwenTTS] Cloning voice from {os.path.basename(ref_audio_path)}...")
            
            gen_kwargs = _build_qwen_generation_kwargs(
                {
                    **kwargs,
                    "_real_model": getattr(model, "model", None)
                },
                text=text,
                adaptive_max_new_tokens=True
            )
            
            # Pass other kwargs directly if needed or filter?
            # generate_voice_clone handles them via **kwargs usually
            
            wavs, sr = model.generate_voice_clone(
                text=text,
                language=language, # Use passed language
                voice_clone_prompt=None, 
                ref_audio=ref_audio_path,
                ref_text=ref_text,
                x_vector_only_mode=x_vector_mode,
                **gen_kwargs
            )
            
            sf.write(output_path, wavs[0], sr)
            if not _validate_or_cleanup(output_path):
                return _generate_preset_fallback()
            print(f"[QwenTTS] Saved to {output_path}")
            return True
            
        else:
            print(f"[QwenTTS] Unknown mode: {mode}")
            return False

    except Exception as e:
        print(f"[QwenTTS] Error: {e}")
        traceback.print_exc()
        return False

def run_batch_qwen_tts(tasks, language="Auto", **kwargs):
    """
    Batch TTS entry point.
    tasks: list of {text, ref_audio_path, output_path, ...}
    """
    mode = kwargs.get('qwen_mode', 'clone')
    model_size = kwargs.get('qwen_model_size', '1.7B')
    print(f"[QwenTTS] Batch Start. Mode: {mode}, Size: {model_size}, Tasks: {len(tasks)}")

    try:
        target_model_type = "Base" # Default for Design-based cloning or pure cloning
        if mode == 'preset':
             target_model_type = "CustomVoice"

        def generate_preset_fallback_for_task(task, reason):
            output_path = task['output_path']
            original_idx = task.get('index')
            speaker = kwargs.get('preset_voice', 'Vivian')
            print(f"[QwenTTS] Task {original_idx} falling back to preset voice '{speaker}': {reason}")
            try:
                fallback_model = get_model("CustomVoice", model_size=model_size)
                wavs, sr = fallback_model.generate_custom_voice(
                    text=task['text'],
                    language=language,
                    speaker=speaker
                )
                sf.write(output_path, wavs[0], sr)
                is_valid, validation_info = validate_generated_audio(output_path)
                if not is_valid:
                    try:
                        if os.path.exists(output_path):
                            os.remove(output_path)
                    except Exception:
                        pass
                    return {
                        "index": original_idx,
                        "success": False,
                        "error": f"Preset fallback rejected: {validation_info}"
                    }
                return {
                    "index": original_idx,
                    "success": True,
                    "audio_path": output_path
                }
            except Exception as fallback_error:
                traceback.print_exc()
                return {
                    "index": original_idx,
                    "success": False,
                    "error": f"Preset fallback failed: {fallback_error}"
                }
        
        model = get_model(target_model_type, model_size=model_size)
        
        # 2. Optimization: If Voice Clone, pre-compute prompt?
        # If all tasks share the SAME ref_audio (Global Ref), we compute prompt once.
        voice_clone_prompt = None
        current_ref_audio = None
        
        # Check if all tasks use same ref
        first_ref = tasks[0]['ref_audio_path'] if tasks else None
        all_same_ref = all(t['ref_audio_path'] == first_ref for t in tasks)
        
        if target_model_type == "Base" and all_same_ref and first_ref:
            # print("[QwenTTS] Optimizing: All tasks use same Reference. Computing prompt once.")
            # Optimization DISABLED: Could cause state contamination or buffer hangs on high batches.
            # We will re-compute prompt for each batch to ensure freshness.
            print("[QwenTTS] Note: Optimization disabled for stability. (Re-computing prompt each batch)")
            voice_clone_prompt = None
            
        requested_batch_size = max(int(kwargs.get('batch_size', 1) or 1), 1)
        batch_size, batch_detail = choose_adaptive_batch_size(requested_batch_size, "qwen_tts")
        if batch_detail:
            print(f"[QwenTTS] Adaptive batch size selected: {format_gpu_snapshot(batch_detail)}")
        
        print(f"[QwenTTS] Processing with batch size: {batch_size}")
        
        total_tasks = len(tasks)
        
        # Helper to process a batch
        def process_batch(batch_tasks, batch_index_start):
            batch_texts = [t['text'] for t in batch_tasks]
            batch_outs = [t['output_path'] for t in batch_tasks]
            
            gen_kwargs = _build_qwen_generation_kwargs(
                {
                    **kwargs,
                    "_real_model": getattr(model, "model", None)
                },
                text=batch_tasks[0].get('text', '') if len(batch_tasks) == 1 else "",
                duration=batch_tasks[0].get('duration') if len(batch_tasks) == 1 else None,
                adaptive_max_new_tokens=(len(batch_tasks) == 1)
            )

            try:
                wavs = []
                sr = 24000 # default
                
                if target_model_type == "Base":
                    if voice_clone_prompt:
                         wavs, sr = model.generate_voice_clone(
                            text=batch_texts,
                            language=language, # Use passed language
                            voice_clone_prompt=voice_clone_prompt,
                            **gen_kwargs
                        )
                    else:
                        current_batch_refs = [t['ref_audio_path'] for t in batch_tasks]
                        if all(r == current_batch_refs[0] for r in current_batch_refs):
                             task_ref_texts = [str(t.get('ref_text') or '') for t in batch_tasks]
                             unique_task_ref_texts = {text for text in task_ref_texts if text}
                             batch_ref_text = kwargs.get('qwen_ref_text', '')
                             if not batch_ref_text and len(unique_task_ref_texts) == 1:
                                 batch_ref_text = next(iter(unique_task_ref_texts))
                             if not batch_ref_text and len(unique_task_ref_texts) > 1:
                                 print(f"[QwenTTS] Mixed reference texts detected for shared ref audio in batch {batch_index_start}. Processing sequentially.")
                                 local_wavs = []
                                 for bt in batch_tasks:
                                     t_ref_text = bt.get('ref_text') or kwargs.get('qwen_ref_text', '')
                                     t_x_vec = False
                                     if not t_ref_text:
                                         t_x_vec = True
                                     w, s = model.generate_voice_clone(
                                        text=bt['text'],
                                        language=language,
                                        ref_audio=bt['ref_audio_path'],
                                        ref_text=t_ref_text,
                                        x_vector_only_mode=t_x_vec,
                                        **gen_kwargs
                                    )
                                     local_wavs.append(w[0])
                                     sr = s
                                 wavs = local_wavs
                             else:
                                 batch_x_vec = False
                                 if not batch_ref_text:
                                     batch_x_vec = True

                                 # model.generate_voice_clone likely handles single ref + list of text.
                                 wavs, sr = model.generate_voice_clone(
                                    text=batch_texts,
                                    language=language,
                                    ref_audio=current_batch_refs[0],
                                    ref_text=batch_ref_text,
                                    x_vector_only_mode=batch_x_vec,
                                    **gen_kwargs
                                )
                        else:
                            # Mixed refs. Must process one by one.
                            # We shouldn't have entered this batched block ideally, strict fallback:
                            # But since we are here, let's just loop locally.
                            print(f"[QwenTTS] Batch {batch_index_start} has mixed refs. Processing sequentially.")
                            local_wavs = []
                            for bt in batch_tasks:
                                t_ref_text = bt.get('ref_text') or kwargs.get('qwen_ref_text', '')
                                t_x_vec = False
                                if not t_ref_text: t_x_vec = True

                                w, s = model.generate_voice_clone(
                                    text=bt['text'], 
                                    language=language, 
                                    ref_audio=bt['ref_audio_path'],
                                    ref_text=t_ref_text,
                                    x_vector_only_mode=t_x_vec,
                                    **gen_kwargs
                                )
                                local_wavs.append(w[0])
                                sr = s
                            wavs = local_wavs

                elif target_model_type == "CustomVoice":
                    speaker = kwargs.get('preset_voice', 'Vivian')
                    wavs, sr = model.generate_custom_voice(
                        text=batch_texts,
                        language=language,
                        speaker=speaker
                    )
                
                # Write outputs
                results = []
                for i, wav in enumerate(wavs):
                    out_p = batch_outs[i]
                    sf.write(out_p, wav, sr)
                    is_valid, validation_info = validate_generated_audio(out_p)

                    # Original task index
                    original_idx = batch_tasks[i].get('index', batch_index_start + i)

                    if not is_valid:
                        try:
                            if os.path.exists(out_p):
                                os.remove(out_p)
                        except Exception:
                            pass
                        if mode == 'clone':
                            fallback_result = generate_preset_fallback_for_task(
                                batch_tasks[i],
                                f"Generated audio rejected: {validation_info}"
                            )
                            results.append(fallback_result)
                            emit_partial_result("generate_batch_tts", fallback_result)
                        else:
                            error_result = {
                                "index": original_idx,
                                "success": False,
                                "error": f"Generated audio rejected: {validation_info}"
                            }
                            results.append(error_result)
                            emit_partial_result("generate_batch_tts", error_result)
                        continue

                    results.append({
                        "index": original_idx,
                        "success": True,
                        "audio_path": out_p
                    })
                    emit_partial_result("generate_batch_tts", {"index": original_idx, "success": True, "audio_path": out_p})

                return results

            except Exception as batch_e:
                print(f"[QwenTTS] Batch failed: {batch_e}")
                emit_issue(
                    "generate_batch_tts",
                    "tts_generate",
                    "warn",
                    "TTS_BATCH_SLICE_FAILED",
                    "当前批次生成失败，正在降级处理",
                    detail=str(batch_e),
                    suggestion="系统将尝试逐条回退，请关注失败片段"
                )
                traceback.print_exc()
                rets = []
                for i, task in enumerate(batch_tasks):
                    original_idx = task.get('index', batch_index_start + i)
                    if mode == 'clone':
                        fallback_result = generate_preset_fallback_for_task(task, str(batch_e))
                        if fallback_result.get("index") is None:
                            fallback_result["index"] = original_idx
                        rets.append(fallback_result)
                        emit_partial_result("generate_batch_tts", fallback_result)
                    else:
                        error_result = {
                            "index": original_idx,
                            "success": False,
                            "error": str(batch_e)
                        }
                        emit_partial_result("generate_batch_tts", error_result)
                        rets.append(error_result)
                return rets

        # Main Loop
        emit_stage(
            "generate_batch_tts",
            "tts_generate",
            f"正在生成 {total_tasks} 条 Qwen 配音",
            stage_label="正在生成配音"
        )
        for i in range(0, total_tasks, batch_size):
            # Safe slice
            end_idx = min(i + batch_size, total_tasks)
            batch_tasks = tasks[i : end_idx]
            emit_progress(
                "generate_batch_tts",
                "tts_generate",
                int((i) / total_tasks * 100) if total_tasks else 0,
                f"正在处理第 {i + 1}-{end_idx}/{total_tasks} 条",
                stage_label="正在生成配音",
                item_index=min(i + 1, total_tasks) if total_tasks else 0,
                item_total=total_tasks,
                detail=f"当前批大小 {len(batch_tasks)}"
            )
            if len(batch_tasks) == 1:
                task = batch_tasks[0]
                print(
                    f"[QwenTTS] Synthesizing index {task.get('index', i)} "
                    f"(max_new_tokens={_compute_adaptive_max_new_tokens(task.get('text', ''), kwargs.get('max_new_tokens', 4096), task.get('duration'))}): "
                    f"'{_preview_text(task.get('text', ''))}'",
                    flush=True
                )
            else:
                print(
                    f"[QwenTTS] Synthesizing batch {i}-{end_idx - 1} ({len(batch_tasks)} items)",
                    flush=True
                )
            
            # Process
            batch_results = process_batch(batch_tasks, i)
            for res in batch_results:
                yield res
                
            # Periodic GC/Empty Cache to prevent memory creep blocking
            if i > 0 and i % (batch_size * 10) == 0:
                 if torch.cuda.is_available():
                     torch.cuda.empty_cache()

    except Exception as e:
        print(f"[QwenTTS] Batch Error: {e}")
        emit_issue(
            "generate_batch_tts",
            "tts_generate",
            "error",
            "TTS_BATCH_FAILED",
            "Qwen 批量配音执行失败",
            detail=str(e),
            suggestion="请查看完整日志，检查模型状态、显存或参考音频"
        )
        traceback.print_exc()

