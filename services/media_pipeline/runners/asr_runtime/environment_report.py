from __future__ import annotations

import platform
import sys


def build_environment_report() -> dict[str, str]:
    return {
        "python_version": sys.version.split()[0],
        "platform": platform.platform(),
        "runtime": "asr-runtime",
    }

