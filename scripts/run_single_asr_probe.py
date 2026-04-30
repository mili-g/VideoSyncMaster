from __future__ import annotations

import argparse
import contextlib
import io
import json
import pathlib
import sys


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT_DIR / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from asr import run_asr


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", required=True)
    parser.add_argument("--audio_path", required=True)
    parser.add_argument("--output_dir", required=True)
    args = parser.parse_args()

    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            result = run_asr(
                args.audio_path,
                service=args.service,
                output_dir=args.output_dir,
            )
        payload = {
            "ok": True,
            "service": args.service,
            "segments": result if isinstance(result, list) else [],
            "captured": captured.getvalue(),
        }
    except Exception as error:
        payload = {
            "ok": False,
            "service": args.service,
            "detail": str(error),
            "captured": captured.getvalue(),
        }

    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
