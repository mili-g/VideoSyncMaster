import hashlib
import os
from typing import Dict

import ffmpeg


TARGET_SAMPLE_RATE = 44100
MODEL_FILENAMES = (
    "hdemucs_high_musdb_plus.pt",
    "hdemucs_high_trained.pt",
)
CACHE_VERSION = "sep_v1"

_MODEL_CACHE = {}


def _project_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _model_root() -> str:
    return os.path.join(_project_root(), "models", "source_separation")


def _setup_portable_ffmpeg() -> None:
    backend_root = os.path.dirname(os.path.abspath(__file__))
    ffmpeg_bin = os.path.join(backend_root, "ffmpeg", "bin")
    ffmpeg_exe = os.path.join(ffmpeg_bin, "ffmpeg.exe")
    if os.path.exists(ffmpeg_exe):
        current_path = os.environ.get("PATH", "")
        if ffmpeg_bin not in current_path:
            os.environ["PATH"] = ffmpeg_bin + os.pathsep + current_path


_setup_portable_ffmpeg()


def _video_fingerprint(video_path: str) -> str:
    stat = os.stat(video_path)
    payload = "|".join(
        [
            CACHE_VERSION,
            os.path.abspath(video_path),
            str(stat.st_size),
            str(int(stat.st_mtime)),
            MODEL_FILENAMES[0],
            str(TARGET_SAMPLE_RATE),
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _cache_dir(video_path: str, output_path: str) -> str:
    output_dir = os.path.dirname(os.path.abspath(output_path)) or os.getcwd()
    return os.path.join(output_dir, ".cache", "source_separation", _video_fingerprint(video_path))


def _extract_video_audio(video_path: str, audio_path: str, sample_rate: int) -> None:
    os.makedirs(os.path.dirname(audio_path), exist_ok=True)
    (
        ffmpeg
        .input(video_path)
        .output(
            audio_path,
            acodec="pcm_s16le",
            ac=2,
            ar=sample_rate,
            loglevel="error",
        )
        .run(overwrite_output=True, quiet=True)
    )


def _ensure_model_weights():
    import torchaudio

    model_root = _model_root()
    os.makedirs(model_root, exist_ok=True)
    for filename in MODEL_FILENAMES:
        model_path = os.path.join(model_root, filename)
        if os.path.exists(model_path):
            return model_path

    model_path = os.path.join(model_root, MODEL_FILENAMES[0])

    bundle = torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS
    print(f"[SourceSeparation] Downloading separation weights to {model_path}")
    try:
        torchaudio.utils.download_asset(bundle._model_path, path=model_path, progress=True)
    except Exception as error:
        raise RuntimeError(
            "Failed to download local separation weights. "
            "Place the HDemucs weights in models/source_separation manually."
        ) from error

    return model_path


def _load_model():
    import torch
    import torchaudio

    device = "cuda" if torch.cuda.is_available() else "cpu"
    cache_key = f"hdemucs:{device}"
    cached = _MODEL_CACHE.get(cache_key)
    if cached is not None:
        return cached

    bundle = torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS
    model = bundle._model_factory_func()
    model_path = _ensure_model_weights()

    try:
        state_dict = torch.load(model_path, map_location="cpu", weights_only=True)
    except TypeError:
        state_dict = torch.load(model_path, map_location="cpu")

    model.load_state_dict(state_dict)
    model.to(device)
    model.eval()

    result = {
        "model": model,
        "device": device,
        "sample_rate": bundle.sample_rate,
        "sources": list(getattr(model, "sources", ["drums", "bass", "other", "vocals"])),
    }
    _MODEL_CACHE[cache_key] = result
    return result


def _make_chunk_weight(length: int, fade: int, is_first: bool, is_last: bool):
    import torch

    weight = torch.ones(length, dtype=torch.float32)
    if fade <= 0 or length <= 1:
        return weight

    fade = min(fade, length // 2)
    if fade <= 0:
        return weight

    ramp = torch.linspace(0.0, 1.0, fade, dtype=torch.float32)
    if not is_first:
        weight[:fade] = ramp
    if not is_last:
        weight[-fade:] = ramp.flip(0)
    return weight


def _match_num_frames(tensor, target_frames: int):
    import torch

    current_frames = tensor.shape[-1]
    if current_frames == target_frames:
        return tensor
    if current_frames > target_frames:
        return tensor[..., :target_frames]
    return torch.nn.functional.pad(tensor, (0, target_frames - current_frames))


def _run_model_on_waveform(model, device: str, waveform, sample_rate: int):
    import torch
    import torchaudio

    if waveform.ndim == 1:
        waveform = waveform.unsqueeze(0)
    if waveform.shape[0] == 1:
        waveform = waveform.repeat(2, 1)
    elif waveform.shape[0] > 2:
        waveform = waveform[:2, :]

    target_sample_rate = TARGET_SAMPLE_RATE
    if sample_rate != target_sample_rate:
        waveform = torchaudio.functional.resample(waveform, sample_rate, target_sample_rate)

    waveform = waveform.to(torch.float32)
    total_frames = waveform.shape[-1]
    chunk_frames = target_sample_rate * (18 if device == "cuda" else 10)
    overlap_frames = target_sample_rate * 2
    step = max(chunk_frames - overlap_frames, target_sample_rate * 4)

    with torch.inference_mode():
        probe_out = model(waveform[:, : min(total_frames, chunk_frames)].unsqueeze(0).to(device))
    num_sources = probe_out.shape[1]
    del probe_out

    aggregate = torch.zeros((num_sources, waveform.shape[0], total_frames), dtype=torch.float32)
    aggregate_weight = torch.zeros(total_frames, dtype=torch.float32)

    chunk_index = 0
    for start in range(0, total_frames, step):
        end = min(total_frames, start + chunk_frames)
        chunk = waveform[:, start:end]
        is_first = start == 0
        is_last = end >= total_frames
        weight = _make_chunk_weight(chunk.shape[-1], overlap_frames // 2, is_first, is_last)

        try:
            with torch.inference_mode():
                estimated = model(chunk.unsqueeze(0).to(device))[0].detach().cpu().to(torch.float32)
        except RuntimeError as error:
            if "out of memory" in str(error).lower() and device == "cuda":
                torch.cuda.empty_cache()
            raise RuntimeError(f"Source separation failed on chunk {chunk_index}: {error}") from error

        estimated = _match_num_frames(estimated, chunk.shape[-1])
        aggregate[:, :, start:end] += estimated * weight.view(1, 1, -1)
        aggregate_weight[start:end] += weight
        chunk_index += 1
        print(
            f"[SourceSeparation] Processed chunk {chunk_index}: "
            f"{start / target_sample_rate:.2f}s-{end / target_sample_rate:.2f}s"
        )

    aggregate /= aggregate_weight.clamp_min(1e-6).view(1, 1, -1)
    return aggregate, target_sample_rate


def prepare_background_stem(video_path: str, output_path: str) -> Dict[str, str]:
    import torch
    import torchaudio

    cache_dir = _cache_dir(video_path, output_path)
    os.makedirs(cache_dir, exist_ok=True)

    mixed_audio_path = os.path.join(cache_dir, "mixture.wav")
    vocals_path = os.path.join(cache_dir, "vocals.wav")
    background_path = os.path.join(cache_dir, "background.wav")

    if os.path.exists(background_path) and os.path.exists(vocals_path):
        return {
            "cache_dir": cache_dir,
            "mixture_path": mixed_audio_path,
            "background_path": background_path,
            "vocals_path": vocals_path,
        }

    if not os.path.exists(mixed_audio_path):
        print(f"[SourceSeparation] Extracting full mix from {video_path}")
        _extract_video_audio(video_path, mixed_audio_path, TARGET_SAMPLE_RATE)

    model_spec = _load_model()
    print(f"[SourceSeparation] Running HDemucs on {mixed_audio_path} using {model_spec['device']}")

    waveform, sample_rate = torchaudio.load(mixed_audio_path)
    separated, target_sample_rate = _run_model_on_waveform(
        model_spec["model"],
        model_spec["device"],
        waveform,
        sample_rate,
    )

    sources = model_spec["sources"]
    if "vocals" not in sources:
        raise RuntimeError(f"Unexpected source layout from separation model: {sources}")

    vocals_index = sources.index("vocals")
    vocals = separated[vocals_index]
    background = separated.sum(dim=0) - vocals

    background = background.clamp(-1.0, 1.0)
    vocals = vocals.clamp(-1.0, 1.0)

    torchaudio.save(background_path, background, target_sample_rate)
    torchaudio.save(vocals_path, vocals, target_sample_rate)

    if model_spec["device"] == "cuda":
        torch.cuda.empty_cache()

    print(f"[SourceSeparation] Saved background stem to {background_path}")
    print(f"[SourceSeparation] Saved vocals stem to {vocals_path}")

    return {
        "cache_dir": cache_dir,
        "mixture_path": mixed_audio_path,
        "background_path": background_path,
        "vocals_path": vocals_path,
    }
