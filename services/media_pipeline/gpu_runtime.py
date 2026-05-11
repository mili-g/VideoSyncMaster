import math


def _load_torch():
    try:
        import torch
        return torch
    except Exception:
        return None


def get_single_gpu_memory_snapshot():
    torch = _load_torch()
    if torch is None or not torch.cuda.is_available():
        return None

    try:
        if torch.cuda.device_count() != 1:
            return None

        free_bytes, total_bytes = torch.cuda.mem_get_info(0)
        return {
            "free_bytes": int(free_bytes),
            "total_bytes": int(total_bytes),
            "free_gb": float(free_bytes) / (1024 ** 3),
            "total_gb": float(total_bytes) / (1024 ** 3)
        }
    except Exception:
        return None


def classify_single_gpu_tier(snapshot=None):
    if snapshot is None:
        snapshot = get_single_gpu_memory_snapshot()
    if snapshot is None:
        return "unknown"

    free_gb = float(snapshot.get("free_gb") or 0.0)
    total_gb = float(snapshot.get("total_gb") or 0.0)
    free_ratio = (free_gb / total_gb) if total_gb > 0 else 0.0

    if free_gb < 2.5 or free_ratio < 0.12:
        return "critical"
    if total_gb < 10.0 or free_gb < 4.0 or free_ratio < 0.22:
        return "tight"
    if total_gb < 16.0 or free_gb < 7.0 or free_ratio < 0.35:
        return "balanced"
    return "roomy"


def _clamp_batch_size(value, requested):
    requested = max(int(requested or 1), 1)
    return max(1, min(int(value), requested))


def choose_adaptive_batch_size(requested_batch_size, workload):
    requested = max(int(requested_batch_size or 1), 1)
    snapshot = get_single_gpu_memory_snapshot()
    if snapshot is None:
        return requested, None

    free_gb = snapshot["free_gb"]
    workload = str(workload or "").lower()

    if workload == "asr":
        if free_gb < 3.5:
            adaptive = 1
        elif free_gb < 5.5:
            adaptive = 2
        elif free_gb < 8.5:
            adaptive = 4
        else:
            adaptive = 6
    elif workload == "qwen_tts":
        if free_gb < 5.5:
            adaptive = 1
        elif free_gb < 8.5:
            adaptive = 2
        elif free_gb < 12.5:
            adaptive = 3
        elif free_gb < 18.0:
            adaptive = 4
        else:
            adaptive = 5
    else:
        if free_gb < 4.5:
            adaptive = 1
        elif free_gb < 6.5:
            adaptive = 2
        elif free_gb < 9.5:
            adaptive = 3
        elif free_gb < 12.5:
            adaptive = 4
        elif free_gb < 16.0:
            adaptive = 6
        else:
            adaptive = 8

    adaptive = _clamp_batch_size(adaptive, requested)
    detail = {
        **snapshot,
        "requested_batch_size": requested,
        "adaptive_batch_size": adaptive,
        "workload": workload
    }
    return adaptive, detail


def format_gpu_snapshot(detail):
    if not detail:
        return "GPU memory snapshot unavailable"

    free_gb = detail.get("free_gb")
    total_gb = detail.get("total_gb")
    requested = detail.get("requested_batch_size")
    adaptive = detail.get("adaptive_batch_size")
    tier = classify_single_gpu_tier(detail)

    free_text = f"{free_gb:.2f}GB" if isinstance(free_gb, (float, int)) and math.isfinite(free_gb) else "unknown"
    total_text = f"{total_gb:.2f}GB" if isinstance(total_gb, (float, int)) and math.isfinite(total_gb) else "unknown"
    if requested is None or adaptive is None:
        return f"tier {tier}, free {free_text} / total {total_text}"
    return f"tier {tier}, free {free_text} / total {total_text}, batch {requested} -> {adaptive}"
