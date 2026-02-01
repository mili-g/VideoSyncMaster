import os
import sys
import torch
import soundfile as sf
import traceback
import json

# Ensure environment requirements
try:
    from dependency_manager import ensure_transformers_version
    ensure_transformers_version("4.57.3")
except ImportError:
    print("[QwenTTS] Dependency manager not found, skipping version check.")

# Ensure qwen-tts can be imported
try:
    from qwen_tts import Qwen3TTSModel
except ImportError:
    Qwen3TTSModel = None
    print("[QwenTTS] Error: qwen-tts package not installed.")

# Global Model Cache
# { 'model_type': model_instance }
# types: 'VoiceDesign', 'Base', 'CustomVoice'
_loaded_models = {}

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
                return False
                
            model = get_model("Base", model_size=model_size)
            
            print(f"[QwenTTS] Cloning voice from {os.path.basename(ref_audio_path)}...")
            
            # Ensure we have a valid pad_token_id to prevent open-end generation hangs
            gen_kwargs = {}
            
            real_model = getattr(model, 'model', None)
            pad_id = 2150 # Default fallback
            
            if real_model:
                 if hasattr(real_model, 'generation_config') and getattr(real_model.generation_config, 'pad_token_id', None) is not None:
                      pad_id = real_model.generation_config.pad_token_id
                 elif hasattr(real_model, 'config') and getattr(real_model.config, 'pad_token_id', None) is not None:
                      pad_id = real_model.config.pad_token_id
            
            gen_kwargs['pad_token_id'] = int(pad_id)
            
            # Use user provided parameters
            gen_kwargs['max_new_tokens'] = int(kwargs.get('max_new_tokens', 4096))
            # Removed safety cap as requested

            gen_kwargs['temperature'] = float(kwargs.get('temperature', 0.7))
            gen_kwargs['top_p'] = float(kwargs.get('top_p', 0.8))
            gen_kwargs['repetition_penalty'] = float(kwargs.get('repetition_penalty', 1.0))
            if kwargs.get('do_sample'): gen_kwargs['do_sample'] = True
            
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
            
        batch_size = kwargs.get('batch_size', 1)
        if batch_size < 1: batch_size = 1
        
        print(f"[QwenTTS] Processing with batch size: {batch_size}")
        
        total_tasks = len(tasks)
        
        # Helper to process a batch
        def process_batch(batch_tasks, batch_index_start):
            batch_texts = [t['text'] for t in batch_tasks]
            batch_outs = [t['output_path'] for t in batch_tasks]
            
            # Ensure we have a valid pad_token_id (Critical for hang fix)
            gen_kwargs = {}
            # Re-fetch from model state or use fallback
            real_model = getattr(model, 'model', None)
            pad_id = 2150 # Default fallback
            
            if real_model:
                 if hasattr(real_model, 'generation_config') and getattr(real_model.generation_config, 'pad_token_id', None) is not None:
                      pad_id = real_model.generation_config.pad_token_id
                 elif hasattr(real_model, 'config') and getattr(real_model.config, 'pad_token_id', None) is not None:
                      pad_id = real_model.config.pad_token_id
            
            gen_kwargs['pad_token_id'] = int(pad_id)
            
            # Restore user parameters
            gen_kwargs['max_new_tokens'] = int(kwargs.get('max_new_tokens', 4096))
            # if gen_kwargs['max_new_tokens'] > 2048: gen_kwargs['max_new_tokens'] = 2048

            gen_kwargs['temperature'] = float(kwargs.get('temperature', 0.7))
            gen_kwargs['top_p'] = float(kwargs.get('top_p', 0.8))
            gen_kwargs['repetition_penalty'] = float(kwargs.get('repetition_penalty', 1.0))
            if kwargs.get('do_sample'): gen_kwargs['do_sample'] = True

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
                             batch_ref_text = kwargs.get('qwen_ref_text', '')
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
                                # Determine per-task x-vector mode? 
                                # Currently we only support Global ref text via kwargs. Not per-task ref text.
                                # So assumes global ref text applies or is empty.
                                t_ref_text = kwargs.get('qwen_ref_text', '') 
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
                     
                     # Original task index
                     original_idx = batch_tasks[i].get('index', batch_index_start + i)
                     
                     results.append({
                         "index": original_idx,
                         "success": True, 
                         "audio_path": out_p
                     })
                     print(f"[PARTIAL] {json.dumps({'index': original_idx, 'success': True, 'audio_path': out_p})}", flush=True)

                return results

            except Exception as batch_e:
                print(f"[QwenTTS] Batch failed: {batch_e}")
                traceback.print_exc()
                # Fail all in batch
                rets = []
                for i, task in enumerate(batch_tasks):
                    original_idx = task.get('index', batch_index_start + i)
                    print(f"[PARTIAL] {json.dumps({'index': original_idx, 'success': False, 'error': str(batch_e)})}", flush=True)
                    rets.append({"success": False, "error": str(batch_e)})
                return rets

        # Main Loop
        for i in range(0, total_tasks, batch_size):
            # Safe slice
            end_idx = min(i + batch_size, total_tasks)
            batch_tasks = tasks[i : end_idx]
            print(f"[PROGRESS] {int((i) / total_tasks * 100)}", flush=True)
            
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
        traceback.print_exc()

