from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class TranslationRuntimeConfig:
    model_dir: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None

    @classmethod
    def from_sources(cls, primary: dict[str, Any] | None = None, fallback: dict[str, Any] | None = None) -> "TranslationRuntimeConfig":
        primary = primary or {}
        fallback = fallback or {}
        return cls(
            model_dir=_pick_value(primary, fallback, "model_dir"),
            api_key=_pick_value(primary, fallback, "api_key"),
            base_url=_pick_value(primary, fallback, "base_url"),
            model=_pick_value(primary, fallback, "model")
        )

    def to_translator_kwargs(self) -> dict[str, Any]:
        payload = asdict(self)
        return {key: value for key, value in payload.items() if value not in (None, "")}


@dataclass(frozen=True)
class TtsRuntimeConfig:
    temperature: float = 0.8
    top_p: float = 0.8
    top_k: int = 5
    repetition_penalty: float = 1.0
    cfg_scale: float = 0.7
    num_beams: int = 1
    length_penalty: float = 1.0
    max_new_tokens: int = 2048
    target_duration: float | None = None
    qwen_mode: str = "clone"
    voice_instruct: str = ""
    preset_voice: str = "Vivian"
    qwen_model_size: str = "1.7B"
    qwen_ref_text: str = ""
    batch_size: int = 10
    voice_mode: str = "clone"
    ref_audio: str | None = None
    fallback_ref_audio: str | None = None
    fallback_ref_text: str = ""
    nearby_ref_audios: Any = None

    @classmethod
    def from_sources(cls, primary: dict[str, Any] | None = None, fallback: dict[str, Any] | None = None) -> "TtsRuntimeConfig":
        primary = primary or {}
        fallback = fallback or {}
        max_new_tokens = _pick_int(primary, fallback, "max_new_tokens", default=2048)
        return cls(
            temperature=_pick_float(primary, fallback, "temperature", default=0.8),
            top_p=_pick_float(primary, fallback, "top_p", default=0.8),
            top_k=_pick_int(primary, fallback, "top_k", default=5),
            repetition_penalty=_pick_float(primary, fallback, "repetition_penalty", default=1.0),
            cfg_scale=_pick_float(primary, fallback, "cfg_scale", default=0.7),
            num_beams=_pick_int(primary, fallback, "num_beams", default=1),
            length_penalty=_pick_float(primary, fallback, "length_penalty", default=1.0),
            max_new_tokens=max_new_tokens,
            target_duration=_pick_optional_float(primary, fallback, "target_duration", fallback_keys=("duration",)),
            qwen_mode=_pick_str(primary, fallback, "qwen_mode", default="clone"),
            voice_instruct=_pick_str(primary, fallback, "voice_instruct", default=""),
            preset_voice=_pick_str(primary, fallback, "preset_voice", default="Vivian"),
            qwen_model_size=_pick_str(primary, fallback, "qwen_model_size", default="1.7B"),
            qwen_ref_text=_pick_str(primary, fallback, "qwen_ref_text", default=""),
            batch_size=max(1, _pick_int(primary, fallback, "batch_size", default=10)),
            voice_mode=_pick_str(primary, fallback, "voice_mode", default="clone"),
            ref_audio=_pick_value(primary, fallback, "ref_audio"),
            fallback_ref_audio=_pick_value(primary, fallback, "fallback_ref_audio"),
            fallback_ref_text=_pick_str(primary, fallback, "fallback_ref_text", default=""),
            nearby_ref_audios=_pick_value(primary, fallback, "nearby_ref_audios")
        )

    def to_runner_kwargs(self) -> dict[str, Any]:
        return {
            "temperature": self.temperature,
            "top_p": self.top_p,
            "top_k": self.top_k,
            "repetition_penalty": self.repetition_penalty,
            "inference_cfg_rate": self.cfg_scale,
            "cfg_scale": self.cfg_scale,
            "num_beams": self.num_beams,
            "length_penalty": self.length_penalty,
            "max_new_tokens": self.max_new_tokens,
            "max_mel_tokens": self.max_new_tokens,
            "target_duration": self.target_duration,
            "qwen_mode": self.qwen_mode,
            "voice_instruct": self.voice_instruct,
            "preset_voice": self.preset_voice,
            "qwen_model_size": self.qwen_model_size,
            "qwen_ref_text": self.qwen_ref_text,
            "batch_size": self.batch_size,
            "voice_mode": self.voice_mode,
            "ref_audio": self.ref_audio,
            "fallback_ref_audio": self.fallback_ref_audio,
            "fallback_ref_text": self.fallback_ref_text,
            "nearby_ref_audios": self.nearby_ref_audios
        }


@dataclass(frozen=True)
class DubVideoRuntimeConfig:
    input_path: str
    target_lang: str
    output_path: str
    work_dir: str
    asr_service: str
    vad_onset: float
    vad_offset: float
    tts_service: str
    strategy: str
    audio_mix_mode: str
    ori_lang: str | None
    dub_retry_attempts: int
    translation: TranslationRuntimeConfig
    tts: TtsRuntimeConfig

    @property
    def output_dir_root(self) -> str:
        import os
        return os.path.dirname(self.output_path)

    @property
    def basename(self) -> str:
        import os
        return os.path.splitext(os.path.basename(self.output_path))[0]


@dataclass(frozen=True)
class SingleTtsRequestConfig:
    video_path: str
    output_audio: str
    text: str
    start_time: float
    duration: float
    target_lang: str
    tts_service_name: str
    strategy: str
    dub_retry_attempts: int
    ref_audio: str | None
    fallback_ref_audio: str | None
    fallback_ref_text: str
    nearby_ref_audios: Any
    qwen_ref_text: str
    tts: TtsRuntimeConfig


@dataclass(frozen=True)
class BatchTtsRequestConfig:
    video_path: str
    json_path: str
    work_dir: str
    target_lang: str
    tts_service_name: str
    args_ref_audio: str | None
    explicit_qwen_ref_text: str
    max_retry_attempts: int
    progress_completed_offset: int
    progress_total_override: int
    tts: TtsRuntimeConfig


def build_translation_runtime_config(args) -> TranslationRuntimeConfig:
    payload = {
        "api_key": getattr(args, "api_key", None),
        "base_url": getattr(args, "base_url", None),
        "model": getattr(args, "model", None)
    }
    return TranslationRuntimeConfig.from_sources(payload)


def build_tts_runtime_config(args) -> TtsRuntimeConfig:
    payload = {
        "temperature": getattr(args, "temperature", None),
        "top_p": getattr(args, "top_p", None),
        "top_k": getattr(args, "top_k", None),
        "repetition_penalty": getattr(args, "repetition_penalty", None),
        "cfg_scale": getattr(args, "cfg_scale", None),
        "num_beams": getattr(args, "num_beams", None),
        "length_penalty": getattr(args, "length_penalty", None),
        "max_new_tokens": getattr(args, "max_new_tokens", None),
        "duration": getattr(args, "duration", None),
        "qwen_mode": getattr(args, "qwen_mode", None),
        "voice_instruct": getattr(args, "voice_instruct", None),
        "preset_voice": getattr(args, "preset_voice", None),
        "qwen_model_size": getattr(args, "qwen_model_size", None),
        "qwen_ref_text": getattr(args, "qwen_ref_text", None),
        "batch_size": getattr(args, "batch_size", None),
        "voice_mode": getattr(args, "voice_mode", None),
        "ref_audio": getattr(args, "ref_audio", None),
        "fallback_ref_audio": getattr(args, "fallback_ref_audio", None),
        "fallback_ref_text": getattr(args, "fallback_ref_text", None),
        "nearby_ref_audios": getattr(args, "nearby_ref_audios", None)
    }
    return TtsRuntimeConfig.from_sources(payload)


def build_dub_video_runtime_config(
    *,
    input_path: str,
    target_lang: str,
    output_path: str,
    asr_service: str = "whisperx",
    vad_onset: float = 0.700,
    vad_offset: float = 0.700,
    tts_service: str = "indextts",
    kwargs: dict[str, Any] | None = None
) -> DubVideoRuntimeConfig:
    kwargs = kwargs or {}
    translation_kwargs = dict(kwargs)
    translation_kwargs.pop("model_dir", None)
    translation = TranslationRuntimeConfig.from_sources(translation_kwargs)
    tts = TtsRuntimeConfig.from_sources(kwargs)
    work_dir = str(kwargs.get("work_dir") or "")
    if not work_dir:
        import os
        work_dir = os.path.dirname(output_path)

    return DubVideoRuntimeConfig(
        input_path=input_path,
        target_lang=target_lang,
        output_path=output_path,
        work_dir=work_dir,
        asr_service=asr_service,
        vad_onset=float(vad_onset),
        vad_offset=float(vad_offset),
        tts_service=tts_service,
        strategy=str(kwargs.get("strategy") or "auto_speedup"),
        audio_mix_mode=str(kwargs.get("audio_mix_mode") or "preserve_background"),
        ori_lang=kwargs.get("ori_lang"),
        dub_retry_attempts=max(0, int(kwargs.get("dub_retry_attempts", 3) or 0)),
        translation=translation,
        tts=tts
    )


def build_single_tts_request_config(args, tts_kwargs: dict[str, Any] | None = None) -> SingleTtsRequestConfig:
    tts = TtsRuntimeConfig.from_sources(tts_kwargs, vars(args))
    return SingleTtsRequestConfig(
        video_path=str(getattr(args, "input", "") or ""),
        output_audio=str(getattr(args, "output", "") or ""),
        text=str(getattr(args, "text", "") or ""),
        start_time=float(getattr(args, "start", 0.0) or 0.0),
        duration=float(getattr(args, "duration", 3.0) or 3.0),
        target_lang=str(getattr(args, "lang", "English") or "English"),
        tts_service_name=str(getattr(args, "tts_service", "indextts") or "indextts"),
        strategy=str(getattr(args, "strategy", "auto_speedup") or "auto_speedup"),
        dub_retry_attempts=max(0, int(getattr(args, "dub_retry_attempts", 3) or 0)),
        ref_audio=getattr(args, "ref_audio", None),
        fallback_ref_audio=getattr(args, "fallback_ref_audio", None),
        fallback_ref_text=str(getattr(args, "fallback_ref_text", "") or ""),
        nearby_ref_audios=getattr(args, "nearby_ref_audios", None),
        qwen_ref_text=str(getattr(args, "qwen_ref_text", "") or ""),
        tts=tts
    )


def build_batch_tts_request_config(args, tts_kwargs: dict[str, Any] | None = None) -> BatchTtsRequestConfig:
    tts = TtsRuntimeConfig.from_sources(tts_kwargs, vars(args))
    json_path = str(getattr(args, "ref", "") or "")
    import os
    return BatchTtsRequestConfig(
        video_path=str(getattr(args, "input", "") or ""),
        json_path=json_path,
        work_dir=os.path.dirname(json_path) if json_path else "",
        target_lang=str(getattr(args, "lang", "English") or "English"),
        tts_service_name=str(getattr(args, "tts_service", "indextts") or "indextts"),
        args_ref_audio=getattr(args, "ref_audio", None),
        explicit_qwen_ref_text=str(getattr(args, "qwen_ref_text", "") or ""),
        max_retry_attempts=max(0, int(getattr(args, "dub_retry_attempts", 3) or 0)),
        progress_completed_offset=max(0, int(getattr(args, "resume_completed", 0) or 0)),
        progress_total_override=max(0, int(getattr(args, "resume_total", 0) or 0)),
        tts=tts
    )


def _pick_value(primary: dict[str, Any], fallback: dict[str, Any], key: str, *, fallback_keys: tuple[str, ...] = ()) -> Any:
    for candidate in (key, *fallback_keys):
        value = primary.get(candidate)
        if value not in (None, ""):
            return value
    for candidate in (key, *fallback_keys):
        value = fallback.get(candidate)
        if value not in (None, ""):
            return value
    return None


def _pick_str(primary: dict[str, Any], fallback: dict[str, Any], key: str, *, default: str = "") -> str:
    value = _pick_value(primary, fallback, key)
    if value is None:
        return default
    return str(value)


def _pick_int(primary: dict[str, Any], fallback: dict[str, Any], key: str, *, default: int) -> int:
    value = _pick_value(primary, fallback, key)
    try:
        return int(value)
    except Exception:
        return default


def _pick_float(primary: dict[str, Any], fallback: dict[str, Any], key: str, *, default: float) -> float:
    value = _pick_value(primary, fallback, key)
    try:
        return float(value)
    except Exception:
        return default


def _pick_optional_float(
    primary: dict[str, Any],
    fallback: dict[str, Any],
    key: str,
    *,
    fallback_keys: tuple[str, ...] = ()
) -> float | None:
    value = _pick_value(primary, fallback, key, fallback_keys=fallback_keys)
    if value in (None, ""):
        return None
    try:
        return float(value)
    except Exception:
        return None
