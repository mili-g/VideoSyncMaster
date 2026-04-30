import os

import numpy as np
import soundfile as sf


def validate_generated_audio(
    audio_path,
    *,
    min_duration_sec=0.12,
    min_peak=0.005,
    min_rms=0.0015,
    min_non_silent_ratio=0.02,
    silence_floor=0.001
):
    if not audio_path or not os.path.exists(audio_path):
        return False, "Audio file not found"

    try:
        audio, sample_rate = sf.read(audio_path, always_2d=False)
        audio = np.asarray(audio, dtype=np.float32)
        if audio.size == 0:
            return False, "Audio file is empty"

        if audio.ndim > 1:
            audio = np.mean(audio, axis=1)

        duration = float(audio.shape[0]) / float(sample_rate or 1)
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
        non_silent_ratio = float(np.mean(np.abs(audio) > silence_floor)) if audio.size else 0.0

        if duration < min_duration_sec:
            return False, f"Audio too short ({duration:.3f}s)"
        if peak < min_peak:
            return False, f"Audio peak too low ({peak:.6f})"
        if rms < min_rms:
            return False, f"Audio RMS too low ({rms:.6f})"
        if non_silent_ratio < min_non_silent_ratio:
            return False, f"Audio mostly silent ({non_silent_ratio:.4f})"

        return True, {
            "duration": duration,
            "peak": peak,
            "rms": rms,
            "non_silent_ratio": non_silent_ratio
        }
    except Exception as error:
        return False, str(error)


def validate_generated_audio_array(
    audio,
    sample_rate,
    *,
    min_duration_sec=0.12,
    min_peak=0.005,
    min_rms=0.0015,
    min_non_silent_ratio=0.02,
    silence_floor=0.001
):
    try:
        audio = np.asarray(audio, dtype=np.float32)
        if audio.size == 0:
            return False, "Audio array is empty"

        if audio.ndim > 1:
            audio = np.mean(audio, axis=0 if audio.shape[0] <= 8 else 1)

        duration = float(audio.shape[-1]) / float(sample_rate or 1)
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
        non_silent_ratio = float(np.mean(np.abs(audio) > silence_floor)) if audio.size else 0.0

        if duration < min_duration_sec:
            return False, f"Audio too short ({duration:.3f}s)"
        if peak < min_peak:
            return False, f"Audio peak too low ({peak:.6f})"
        if rms < min_rms:
            return False, f"Audio RMS too low ({rms:.6f})"
        if non_silent_ratio < min_non_silent_ratio:
            return False, f"Audio mostly silent ({non_silent_ratio:.4f})"

        return True, {
            "duration": duration,
            "peak": peak,
            "rms": rms,
            "non_silent_ratio": non_silent_ratio
        }
    except Exception as error:
        return False, str(error)
