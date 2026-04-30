from __future__ import annotations

import json
import pathlib
import sys
import wave
from math import sin, pi
from struct import pack


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT_DIR / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from asr_runtime_diagnostics import run_asr_diagnostics


def ensure_probe_audio() -> pathlib.Path:
    target = ROOT_DIR / "storage" / "cache" / "asr_diag_test.wav"
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        return target

    frame_rate = 16000
    with wave.open(str(target), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(frame_rate)
        for index in range(frame_rate):
            value = int(8000 * sin(2 * pi * 440 * index / frame_rate))
            handle.writeframes(pack("<h", value))
    return target


def main() -> int:
    probe_audio_path = ensure_probe_audio()
    summary = run_asr_diagnostics(str(probe_audio_path))
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if not summary["failed_checks"] and not summary["failed_probes"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
