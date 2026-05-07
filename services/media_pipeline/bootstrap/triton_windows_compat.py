from __future__ import annotations

import importlib.util
import os
from pathlib import Path


_BUGGY_SNIPPET = """def find_winsdk_registry():
    try:
        reg = winreg.ConnectRegistry(None, winreg.HKEY_LOCAL_MACHINE)
        key = winreg.OpenKeyEx(
            reg, r"SOFTWARE\\WOW6432Node\\Microsoft\\Microsoft SDKs\\Windows\\v10.0"
        )
        folder = winreg.QueryValueEx(key, "InstallationFolder")[0]
        winreg.CloseKey(key)
    except OSError:
        return None
"""

_FIXED_SNIPPET = """def find_winsdk_registry():
    try:
        reg = winreg.ConnectRegistry(None, winreg.HKEY_LOCAL_MACHINE)
        key = winreg.OpenKeyEx(
            reg, r"SOFTWARE\\WOW6432Node\\Microsoft\\Microsoft SDKs\\Windows\\v10.0"
        )
        folder = winreg.QueryValueEx(key, "InstallationFolder")[0]
        winreg.CloseKey(key)
    except OSError:
        return None, None
"""


def _resolve_triton_windows_utils_path() -> Path | None:
    spec = importlib.util.find_spec("triton")
    if spec and spec.origin:
        candidate = Path(spec.origin).resolve().parent / "windows_utils.py"
        if candidate.exists():
            return candidate
    return None


def patch_triton_winsdk_registry_bug() -> bool:
    if os.name != "nt":
        return False

    windows_utils_path = _resolve_triton_windows_utils_path()
    if windows_utils_path is None:
        return False

    try:
        content = windows_utils_path.read_text(encoding="utf-8")
    except OSError:
        return False

    if _FIXED_SNIPPET in content or _BUGGY_SNIPPET not in content:
        return False

    try:
        windows_utils_path.write_text(
            content.replace(_BUGGY_SNIPPET, _FIXED_SNIPPET, 1),
            encoding="utf-8",
        )
    except OSError:
        return False

    return True
