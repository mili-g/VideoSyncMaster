from __future__ import annotations

import json
import os
import sys


CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.abspath(os.path.join(CURRENT_DIR, "..", ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from runners.asr_runtime.environment_report import build_environment_report


def main() -> None:
    print(json.dumps({"runtime": "asr-runtime", "environment": build_environment_report()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
