from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from pathlib import Path

LICENSE_TICKET_SECRET_ENV = "VSM_LICENSE_TICKET_SECRET"
BACKEND_WORKER_LANE_ENV = "VSM_BACKEND_WORKER_LANE"
BACKEND_INTEGRITY_ENFORCED_ENV = "VSM_ENFORCE_BACKEND_INTEGRITY"
LICENSE_TICKET_MAX_SKEW_MS = 5_000
PROTECTED_ACTIONS = {
    "test_asr",
    "translate_text",
    "test_tts",
    "merge_video",
    "dub_video",
    "generate_single_tts",
    "generate_batch_tts",
    "prepare_reference_audio",
}
CRITICAL_FILE_HASHES = {
    "main.py": "178A29BC6B52D2CCBC763C32A71ACBA90C0955C60E5963EBF99EDCF6C30DF3B2",
    "cli_options.py": "60498643EF4E2B6686E847C08CE93CC1F53B5153DDEE87EFE4020039AA47BE2E",
    "vsm/interfaces/cli/worker_host.py": "BD20D7C5C2DE51469DCD668B7A6B5D242563054C9314FEEBADF17A906D6A39DD",
}

_USED_TICKET_NONCES: dict[str, int] = {}


class LicensingGuardError(RuntimeError):
    """Raised when a protected backend action fails local licensing guards."""


def _base_dir() -> Path:
    return Path(__file__).resolve().parent


def _sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _cleanup_used_nonces(now_ms: int) -> None:
    expired = [nonce for nonce, exp in _USED_TICKET_NONCES.items() if exp <= now_ms]
    for nonce in expired:
        _USED_TICKET_NONCES.pop(nonce, None)


def _validate_integrity_if_enabled() -> None:
    if os.environ.get(BACKEND_INTEGRITY_ENFORCED_ENV) != "1":
        return

    issues: list[str] = []
    base_dir = _base_dir()
    for relative_path, expected_hash in CRITICAL_FILE_HASHES.items():
        target_path = base_dir / relative_path
        if not target_path.exists():
            issues.append(f"缺少关键文件：{relative_path}")
            continue
        current_hash = _sha256_file(target_path)
        if current_hash != expected_hash:
            issues.append(f"关键文件完整性校验失败：{relative_path}")

    if issues:
        raise LicensingGuardError("运行环境完整性校验失败，请重新安装当前版本客户端。")


def _decode_ticket_payload(token: str) -> dict:
    try:
        token_bytes = token.encode("ascii")
        padding = b"=" * ((4 - len(token_bytes) % 4) % 4)
        decoded = base64.urlsafe_b64decode(token_bytes + padding)
        payload = json.loads(decoded.decode("utf-8"))
    except Exception as error:  # pragma: no cover - defensive
        raise LicensingGuardError(f"授权票据格式无效：{error}") from error

    if not isinstance(payload, dict):
        raise LicensingGuardError("授权票据载荷无效。")
    return payload


def _validate_backend_ticket(args) -> None:
    action = str(getattr(args, "action", "") or "").strip()
    if action not in PROTECTED_ACTIONS:
        return

    secret = os.environ.get(LICENSE_TICKET_SECRET_ENV, "")
    if not secret:
        raise LicensingGuardError("缺少本地授权票据密钥。")

    token = str(getattr(args, "license_ticket", "") or "").strip()
    signature = str(getattr(args, "license_ticket_sig", "") or "").strip()
    if not token or not signature:
        raise LicensingGuardError("当前操作缺少本地授权票据。")

    expected_signature = hmac.new(secret.encode("utf-8"), token.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_signature, signature):
        raise LicensingGuardError("本地授权票据签名无效。")

    payload = _decode_ticket_payload(token)
    ticket_action = str(payload.get("action", "") or "").strip()
    ticket_lane = str(payload.get("lane", "") or "").strip()
    ticket_nonce = str(payload.get("nonce", "") or "").strip()
    ticket_exp = payload.get("exp")
    now_ms = int(time.time() * 1000)

    if ticket_action != action:
        raise LicensingGuardError("本地授权票据动作范围不匹配。")

    worker_lane = str(os.environ.get(BACKEND_WORKER_LANE_ENV, "") or "").strip()
    if worker_lane and ticket_lane != worker_lane:
        raise LicensingGuardError("本地授权票据工作通道不匹配。")

    if not isinstance(ticket_exp, int):
        raise LicensingGuardError("本地授权票据缺少有效时限。")

    if ticket_exp + LICENSE_TICKET_MAX_SKEW_MS < now_ms:
        raise LicensingGuardError("本地授权票据已过期。")

    if not ticket_nonce:
        raise LicensingGuardError("本地授权票据缺少随机标识。")

    _cleanup_used_nonces(now_ms)
    if ticket_nonce in _USED_TICKET_NONCES:
        raise LicensingGuardError("本地授权票据已被使用。")

    _USED_TICKET_NONCES[ticket_nonce] = ticket_exp


def enforce_backend_runtime_guards(args) -> None:
    _validate_integrity_if_enabled()
    _validate_backend_ticket(args)
