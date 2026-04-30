import os


BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BACKEND_DIR, ".."))
PROJECT_ROOT_PROD = os.path.abspath(os.path.join(BACKEND_DIR, "..", ".."))
USER_HOME = os.path.expanduser("~")


DEFAULT_ASR_MODEL_PROFILES = {
    "faster-whisper": "quality",
    "funasr": "standard",
    "qwen": "standard",
    "vibevoice-asr": "standard",
    "jianying": "default",
    "bcut": "default",
}

DEFAULT_TTS_MODEL_PROFILES = {
    "indextts": "standard",
    "qwen": "quality",
}


ASR_MODEL_PROFILES = {
    "funasr": {
        "standard": {
            "label": "SenseVoiceSmall + fsmn-vad",
            "model_name": "SenseVoiceSmall",
            "modelscope_model_id": "iic/SenseVoiceSmall",
            "hf_model_id": "FunAudioLLM/SenseVoiceSmall",
            "vad_model_name": "fsmn-vad",
            "modelscope_vad_id": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
            "use_itn": True,
            "candidates": [
                os.path.join(PROJECT_ROOT, "models", "FunASR-SenseVoiceSmall"),
                os.path.join(PROJECT_ROOT_PROD, "models", "FunASR-SenseVoiceSmall"),
                os.path.join(PROJECT_ROOT, "models", "SenseVoiceSmall"),
                os.path.join(PROJECT_ROOT_PROD, "models", "SenseVoiceSmall"),
                os.path.join(USER_HOME, ".cache", "modelscope", "hub", "models", "iic", "SenseVoiceSmall"),
            ],
            "vad_candidates": [
                os.path.join(PROJECT_ROOT, "models", "FunASR-fsmn-vad"),
                os.path.join(PROJECT_ROOT_PROD, "models", "FunASR-fsmn-vad"),
                os.path.join(USER_HOME, ".cache", "modelscope", "hub", "models", "iic", "speech_fsmn_vad_zh-cn-16k-common-pytorch"),
            ],
            "languages": ["auto", "zh", "yue", "en", "ja", "ko", "nospeech"],
        },
        "zh": {
            "label": "paraformer-zh + fsmn-vad + ct-punc",
            "model_name": "paraformer-zh",
            "modelscope_model_id": "iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
            "vad_model_name": "fsmn-vad",
            "modelscope_vad_id": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
            "punc_model_name": "ct-punc",
            "modelscope_punc_id": "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
            "languages": ["auto", "zh"],
            "use_itn": True,
            "candidates": [
                os.path.join(PROJECT_ROOT, "models", "FunASR-paraformer-zh"),
                os.path.join(PROJECT_ROOT_PROD, "models", "FunASR-paraformer-zh"),
            ],
            "vad_candidates": [
                os.path.join(PROJECT_ROOT, "models", "FunASR-fsmn-vad"),
                os.path.join(PROJECT_ROOT_PROD, "models", "FunASR-fsmn-vad"),
                os.path.join(USER_HOME, ".cache", "modelscope", "hub", "models", "iic", "speech_fsmn_vad_zh-cn-16k-common-pytorch"),
            ],
            "punc_candidates": [
                os.path.join(PROJECT_ROOT, "models", "FunASR-ct-punc"),
                os.path.join(PROJECT_ROOT_PROD, "models", "FunASR-ct-punc"),
            ],
        },
    },
    "faster-whisper": {
        "balanced": {
            "label": "large-v3-turbo",
            "model_name": "large-v3-turbo",
            "candidates": [
                os.path.join(PROJECT_ROOT, "models", "faster-whisper-large-v3-turbo-ct2"),
                os.path.join(PROJECT_ROOT_PROD, "models", "faster-whisper-large-v3-turbo-ct2"),
                os.path.join(PROJECT_ROOT, "models", "faster-whisper-large-v3-ct2"),
                os.path.join(PROJECT_ROOT_PROD, "models", "faster-whisper-large-v3-ct2"),
            ],
        },
        "quality": {
            "label": "large-v3",
            "model_name": "large-v3",
            "candidates": [
                os.path.join(PROJECT_ROOT, "models", "faster-whisper-large-v3-ct2"),
                os.path.join(PROJECT_ROOT_PROD, "models", "faster-whisper-large-v3-ct2"),
                os.path.join(PROJECT_ROOT, "models", "faster-whisper-large-v3-turbo-ct2"),
                os.path.join(PROJECT_ROOT_PROD, "models", "faster-whisper-large-v3-turbo-ct2"),
            ],
        },
    },
    "qwen": {
        "standard": {
            "label": "Qwen3-ASR-1.7B",
            "model_name": "Qwen3-ASR-1.7B",
            "candidates": [
                os.path.join(PROJECT_ROOT, "models", "Qwen3-ASR-1.7B"),
                os.path.join(PROJECT_ROOT_PROD, "models", "Qwen3-ASR-1.7B"),
            ],
        },
        "fast": {
            "label": "Qwen3-ASR-0.6B",
            "model_name": "Qwen3-ASR-0.6B",
            "candidates": [
                os.path.join(PROJECT_ROOT, "models", "Qwen3-ASR-0.6B"),
                os.path.join(PROJECT_ROOT_PROD, "models", "Qwen3-ASR-0.6B"),
            ],
        },
    },
    "vibevoice-asr": {
        "standard": {
            "label": "VibeVoice-ASR-HF",
            "model_name": "VibeVoice-ASR-HF",
            "hf_model_id": "microsoft/VibeVoice-ASR-HF",
            "candidates": [
                os.path.join(PROJECT_ROOT, "models", "VibeVoice-ASR-HF"),
                os.path.join(PROJECT_ROOT_PROD, "models", "VibeVoice-ASR-HF"),
            ],
        },
    },
}


TTS_MODEL_PROFILES = {
    "indextts": {
        "standard": {
            "label": "Index-TTS Standard",
            "model_dir_candidates": [
                os.path.join(PROJECT_ROOT, "models", "index-tts"),
                os.path.join(PROJECT_ROOT_PROD, "models", "index-tts"),
            ],
        },
    },
    "qwen": {
        "quality": {
            "label": "Qwen3-TTS 1.7B",
            "qwen_model_size": "1.7B",
        },
        "fast": {
            "label": "Qwen3-TTS 0.6B",
            "qwen_model_size": "0.6B",
        },
    },
}


def _normalize_key(value):
    return str(value or "").strip().lower().replace("_", "-")


def normalize_asr_model_profile(service, requested_profile=None):
    service_key = _normalize_key(service)
    profiles = ASR_MODEL_PROFILES.get(service_key)
    if not profiles:
        return DEFAULT_ASR_MODEL_PROFILES.get(service_key, "default")

    requested_key = _normalize_key(requested_profile)
    if requested_key in profiles:
        return requested_key
    return DEFAULT_ASR_MODEL_PROFILES.get(service_key, next(iter(profiles.keys())))


def normalize_tts_model_profile(service, requested_profile=None):
    service_key = _normalize_key(service)
    profiles = TTS_MODEL_PROFILES.get(service_key)
    if not profiles:
        return DEFAULT_TTS_MODEL_PROFILES.get(service_key, "default")

    requested_key = _normalize_key(requested_profile)
    if requested_key in profiles:
        return requested_key
    return DEFAULT_TTS_MODEL_PROFILES.get(service_key, next(iter(profiles.keys())))


def get_asr_profile(service, requested_profile=None):
    service_key = _normalize_key(service)
    profiles = ASR_MODEL_PROFILES.get(service_key, {})
    profile_key = normalize_asr_model_profile(service_key, requested_profile)
    return profile_key, profiles.get(profile_key, {})


def get_tts_profile(service, requested_profile=None):
    service_key = _normalize_key(service)
    profiles = TTS_MODEL_PROFILES.get(service_key, {})
    profile_key = normalize_tts_model_profile(service_key, requested_profile)
    return profile_key, profiles.get(profile_key, {})


def resolve_existing_path(candidates):
    for candidate in candidates or []:
        if candidate and os.path.exists(candidate):
            return candidate
    return None
