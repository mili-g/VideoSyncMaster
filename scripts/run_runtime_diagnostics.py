from __future__ import annotations

import json
import pathlib
import subprocess
import sys
from dataclasses import asdict, dataclass
from typing import Any


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT_DIR / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from qwen_tts_service import get_qwen_tts_runtime_status
from tts import get_indextts_runtime_status


@dataclass
class DiagnosticCheck:
    name: str
    ok: bool
    detail: str = ""


def run_command(args: list[str], timeout: int = 180) -> tuple[bool, str]:
    completed = subprocess.run(
        args,
        cwd=ROOT_DIR,
        capture_output=True,
        text=True,
        timeout=timeout,
        encoding="utf-8",
        errors="replace",
    )
    output = "\n".join(part for part in [completed.stdout.strip(), completed.stderr.strip()] if part).strip()
    return completed.returncode == 0, output


def extract_json_block(output: str) -> dict[str, Any] | None:
    lines = output.splitlines()
    for index, line in enumerate(lines):
        if line.strip() != "__JSON_START__":
            continue
        for inner_index in range(index + 1, len(lines)):
            payload = lines[inner_index].strip()
            if not payload or payload == "__JSON_END__":
                continue
            try:
                return json.loads(payload)
            except json.JSONDecodeError:
                break
    return None


def main() -> int:
    checks: list[DiagnosticCheck] = []

    ok, output = run_command([sys.executable, "--version"])
    checks.append(DiagnosticCheck("python_version", ok, output))

    ok, output = run_command([sys.executable, "-c", "import transformers, torch; print(transformers.__version__); print(torch.__version__)"])
    checks.append(DiagnosticCheck("python_packages", ok, output))

    indextts_ok, indextts_detail = get_indextts_runtime_status()
    checks.append(DiagnosticCheck("indextts_runtime_import", indextts_ok, indextts_detail or "ready"))

    qwen_ok, qwen_detail = get_qwen_tts_runtime_status()
    checks.append(DiagnosticCheck("qwen_tts_runtime_import", qwen_ok, qwen_detail or "ready"))

    ok, output = run_command([
        sys.executable,
        "services/media_pipeline/main.py",
        "--action",
        "warmup_tts_runtime",
        "--tts_service",
        "indextts",
        "--json",
    ])
    indextts_result = extract_json_block(output)
    indextts_ok = bool(ok and indextts_result and indextts_result.get("success"))
    checks.append(DiagnosticCheck("warmup_indextts", indextts_ok, output[-3000:]))

    ok, output = run_command([
        sys.executable,
        "services/media_pipeline/main.py",
        "--action",
        "warmup_tts_runtime",
        "--tts_service",
        "qwen",
        "--json",
    ])
    qwen_result = extract_json_block(output)
    qwen_ok = bool(ok and qwen_result and qwen_result.get("success"))
    checks.append(DiagnosticCheck("warmup_qwen_tts", qwen_ok, output[-3000:]))

    summary = {
        "root": str(ROOT_DIR),
        "checks": [asdict(check) for check in checks],
        "failed": [check.name for check in checks if not check.ok],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if not summary["failed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
