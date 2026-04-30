from __future__ import annotations

import argparse
import shutil
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]

DIRECTORIES_TO_REMOVE = [
    ROOT_DIR / "__pycache__",
    ROOT_DIR / "cache",
    ROOT_DIR / "logs",
    ROOT_DIR / "apps" / "desktop" / "ui" / "node_modules",
    ROOT_DIR / "apps" / "desktop" / "ui" / "dist",
    ROOT_DIR / "apps" / "desktop" / "ui" / "dist-electron",
    ROOT_DIR / "apps" / "desktop" / "ui" / "release",
    ROOT_DIR / "apps" / "desktop" / "ui" / "release-package",
    ROOT_DIR / "apps" / "desktop" / "ui" / "release-patch",
]

DIRECTORY_NAMES_TO_PRUNE = {
    "__pycache__",
    ".ipynb_checkpoints",
    ".pytest_cache",
    ".vite",
}

FILE_PATTERNS_TO_REMOVE = [
    "*.pyc",
    "*.pyo",
    "*.tsbuildinfo",
    "*.raw_asr.json",
    "*_raw.json",
    "*_raw.srt",
    "*_debug_repaired.json",
    "*_debug_final.json",
]


def _is_within_root(path: Path) -> bool:
    try:
        path.resolve().relative_to(ROOT_DIR.resolve())
        return True
    except ValueError:
        return False


def _remove_path(path: Path, removed: list[Path]) -> None:
    if not path.exists():
        return
    if not _is_within_root(path):
        raise RuntimeError(f"Refusing to remove path outside workspace: {path}")
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()
    removed.append(path)


def clean_workspace(include_runtime_caches: bool = False) -> list[Path]:
    removed: list[Path] = []

    for directory in DIRECTORIES_TO_REMOVE:
        _remove_path(directory, removed)

    for path in ROOT_DIR.rglob("*"):
        if not _is_within_root(path):
            continue
        if path.is_dir() and path.name in DIRECTORY_NAMES_TO_PRUNE:
            _remove_path(path, removed)

    for pattern in FILE_PATTERNS_TO_REMOVE:
        for path in ROOT_DIR.rglob(pattern):
            if path.is_file():
                _remove_path(path, removed)

    if include_runtime_caches:
        for base in [
            ROOT_DIR / "runtime" / "python",
            ROOT_DIR / "runtime" / "overlays" / "transformers5_asr",
            ROOT_DIR / "storage" / "runtime" / "transformers5_asr",
            ROOT_DIR / "storage" / "cache" / "transformers5_asr_overlay",
            ROOT_DIR / "models",
        ]:
            if not base.exists():
                continue
            for path in base.rglob("__pycache__"):
                if path.is_dir():
                    _remove_path(path, removed)
            for path in base.rglob("*.pyc"):
                if path.is_file():
                    _remove_path(path, removed)

    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description="Clean generated files from the workspace.")
    parser.add_argument(
        "--include-runtime-caches",
        action="store_true",
        help="Also remove __pycache__ and .pyc files under vendored runtime/model caches.",
    )
    args = parser.parse_args()

    removed = clean_workspace(include_runtime_caches=args.include_runtime_caches)
    for path in removed:
        print(path)
    print(f"Removed {len(removed)} generated paths.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
