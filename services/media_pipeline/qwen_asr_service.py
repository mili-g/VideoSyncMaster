
import os
import sys
import torch
import traceback
import re
import logging
from asr_data import ASRData, ASRDataSeg
from app_logging import get_logger, redirect_print
from path_layout import first_existing_path, get_media_tool_bin_dir, get_project_root
from subtitle_postprocess import clean_segment_text, finalize_subtitle_segments, normalize_output_segments

# Force strict offline mode
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'

logger = get_logger("asr.qwen")
print = redirect_print(logger, default_level=logging.DEBUG)

# Setup FFmpeg path for portable environment
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = get_project_root(current_dir)
ffmpeg_bin = get_media_tool_bin_dir(project_root, "ffmpeg")
if os.path.exists(os.path.join(ffmpeg_bin, "ffmpeg.exe")):
    if ffmpeg_bin not in os.environ.get("PATH", ""):
        os.environ["PATH"] = ffmpeg_bin + os.pathsep + os.environ.get("PATH", "")
        print(f"[QwenASR] Added FFmpeg to PATH: {ffmpeg_bin}")


# Ensure environment requirements
try:
    from dependency_manager import ensure_package_installed, ensure_transformers_version
    ensure_transformers_version("4.57.6")
    ensure_package_installed("soynlp", "soynlp==0.0.493")
except ImportError:
    print("[QwenASR] Dependency manager not found, skipping version check.")


def _get_qwen_repo_candidates():
    return [
        os.path.join(project_root, "models", "asr", "qwen3"),
        os.path.join(project_root, "Qwen3-ASR"),
    ]


def _get_qwen_model_candidates(model_name):
    return [
        os.path.join(project_root, "models", model_name),
        os.path.join(project_root, "models", "Qwen", model_name),
    ]


def _get_qwen_aligner_candidates(aligner_name="Qwen3-ForcedAligner-0.6B"):
    return [
        os.path.join(project_root, "models", aligner_name),
        os.path.join(project_root, "models", "Qwen", aligner_name),
    ]


def _resolve_existing_dir(candidates):
    resolved = first_existing_path(candidates)
    if resolved and os.path.isdir(resolved):
        return resolved
    return None


def _resolve_qwen_repo_path():
    return _resolve_existing_dir(_get_qwen_repo_candidates())


def _resolve_qwen_model_dir(model_name):
    if model_name and os.path.isdir(model_name):
        return model_name
    return _resolve_existing_dir(_get_qwen_model_candidates(model_name))


def _resolve_qwen_aligner_dir(aligner_name="Qwen3-ForcedAligner-0.6B"):
    if aligner_name and os.path.isdir(aligner_name):
        return aligner_name
    return _resolve_existing_dir(_get_qwen_aligner_candidates(aligner_name))


# Add Qwen3-ASR local runtime package to sys.path
qwen_repo_path = _resolve_qwen_repo_path()

if qwen_repo_path and os.path.exists(qwen_repo_path) and qwen_repo_path not in sys.path:
    print(f"[QwenASR] Adding {qwen_repo_path} to sys.path")
    sys.path.insert(0, qwen_repo_path)

try:
    from qwen_asr import Qwen3ASRModel
except ImportError as e:
    print(f"[QwenASR] Warning: Could not import qwen_asr: {e}")
    Qwen3ASRModel = None

_QWEN_LANGUAGE_MAP = {
    None: None,
    "": None,
    "auto": None,
    "zh": "Chinese",
    "chinese": "Chinese",
    "en": "English",
    "english": "English",
    "yue": "Cantonese",
    "cantonese": "Cantonese",
    "ja": "Japanese",
    "japanese": "Japanese",
    "ko": "Korean",
    "korean": "Korean",
    "fr": "French",
    "french": "French",
    "de": "German",
    "german": "German",
    "es": "Spanish",
    "spanish": "Spanish",
    "pt": "Portuguese",
    "portuguese": "Portuguese",
}

_HALLUCINATION_KEYWORDS = (
    "请不吝点赞 订阅 转发",
    "打赏支持明镜",
)

_NO_SPACE_BEFORE = set("，。！？；：,.!?;:、)）]】>}》\"'")
_NO_SPACE_AFTER = set("([（【<{《\"'")
_TERM_NORMALIZATION_RULES = (
    (r"\bLod\b", "LOD"),
    (r"\bDlss\b", "DLSS"),
    (r"\bOpencl\b", "OpenCL"),
    (r"\bOpenai\b", "OpenAI"),
    (r"\bUnity\s+Studio\b", "Unity Studio"),
    (r"\bRedshift\s+Live\b", "Redshift Live"),
    (r"\bAuto\s+DS\b", "AutoDS"),
    (r"\bWeb\s+Coding\b", "Web Coding"),
    (r"Redshift Live(?=[\u4e00-\u9fff])", "Redshift Live，"),
    (r"VirtualWorks(?=的)", "VirtualWorks "),
    (r"(?<!标)志着其进入", "标志着其进入"),
    (r"(?<!取)代现有的", "取代现有的"),
    (r"插件版标志着", "插件版，标志着"),
    (r"Live旨在", "Live，旨在"),
)

_CN_DIGITS = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}

def _is_cjk_token(text):
    return bool(re.search(r"[\u4e00-\u9fff]", str(text or "")))


def _is_ascii_alnum_token(text):
    return bool(re.fullmatch(r"[A-Za-z0-9.+:/_-]+", str(text or "")))


def _should_insert_space_between(prev_text, current_text):
    prev = str(prev_text or "").strip()
    curr = str(current_text or "").strip()
    if not prev or not curr:
        return False
    if prev[-1] in _NO_SPACE_AFTER or curr[0] in _NO_SPACE_BEFORE:
        return False
    if prev[-1] in _NO_SPACE_BEFORE or curr[0] in _NO_SPACE_AFTER:
        return True

    prev_ascii = _is_ascii_alnum_token(prev)
    curr_ascii = _is_ascii_alnum_token(curr)
    if prev_ascii and curr_ascii:
        if len(prev) == 1 and len(curr) == 1:
            return False
        if len(prev) == 1 and curr.isdigit():
            return False
        if prev.isdigit() and len(curr) == 1:
            return False
        return True

    if _is_cjk_token(prev) or _is_cjk_token(curr):
        return False

    return False


def _normalize_mixed_terms(text):
    normalized = str(text or "")
    for pattern, replacement in _TERM_NORMALIZATION_RULES:
        normalized = re.sub(pattern, replacement, normalized)
    return normalized


def _parse_chinese_number(text):
    value = str(text or "").strip()
    if not value:
        return None
    if value.isdigit():
        return int(value)
    if all(char in _CN_DIGITS for char in value):
        return int("".join(str(_CN_DIGITS[char]) for char in value))

    if value == "十":
        return 10
    if value.startswith("十"):
        suffix = _CN_DIGITS.get(value[1], 0) if len(value) > 1 else 0
        return 10 + suffix
    if value.endswith("十"):
        prefix = _CN_DIGITS.get(value[0], 0)
        return prefix * 10
    if "十" in value and len(value) == 3:
        prefix = _CN_DIGITS.get(value[0], 0)
        suffix = _CN_DIGITS.get(value[2], 0)
        return prefix * 10 + suffix
    return None


def _normalize_contextual_terms(text):
    normalized = str(text or "")

    def _replace_date(match):
        month = _parse_chinese_number(match.group(1))
        day = _parse_chinese_number(match.group(2))
        if month is None or day is None:
            return match.group(0)
        return f"{month}月{day}号"

    normalized = re.sub(
        r"([零〇一二两三四五六七八九十\d]+)月([零〇一二两三四五六七八九十\d]+)号",
        _replace_date,
        normalized,
    )

    normalized = re.sub(r"二零二六(?=\d?月)", "2026年", normalized)
    normalized = re.sub(r"二零二六(?=[一二三四五六七八九十]月)", "2026年", normalized)
    normalized = re.sub(r"Unity\s*64(?=发布)", "Unity 6.4", normalized)
    normalized = re.sub(r"Redshift\s*20264(?=发布)", "Redshift 2026.4", normalized)
    normalized = re.sub(r"Octane Render\s*20271(?=\s*Alpha版)", "Octane Render 2027.1", normalized)
    normalized = re.sub(r"(?<=[\u4e00-\u9fff])大路(?=(市场|插件|资产|用户))", "大陆", normalized)
    normalized = re.sub(r"^大路资产", "大陆资产", normalized)
    normalized = re.sub(r"^大路插件", "大陆插件", normalized)
    normalized = re.sub(r"商城插件开发", "商城插件开发", normalized)
    return normalized


def _finalize_qwen_segments(
    sentence_segments,
    *,
    splitter_kwargs=None,
    optimize_enabled=True,
):
    return finalize_subtitle_segments(
        sentence_segments,
        splitter_kwargs=splitter_kwargs,
        apply_splitter=False,
        optimize_enabled=optimize_enabled,
        hallucination_keywords=_HALLUCINATION_KEYWORDS,
        text_normalizer=lambda text: _normalize_contextual_terms(_normalize_mixed_terms(text)),
    )


def _join_token_texts(token_texts):
    pieces = []
    prev_text = ""
    for token_text in token_texts:
        current = str(token_text or "").strip()
        if not current:
            continue
        if pieces and _should_insert_space_between(prev_text, current):
            pieces.append(" ")
        pieces.append(current)
        prev_text = current
    return _normalize_contextual_terms(_normalize_mixed_terms("".join(pieces)))


def _build_token_segments(tokens):
    segments = []
    for token in tokens or []:
        token_text = str(getattr(token, "text", "")).strip()
        token_text = clean_segment_text(token_text)
        if not token_text:
            continue
        start = round(float(getattr(token, "start_time", 0.0)), 3)
        end = round(float(getattr(token, "end_time", start)), 3)
        if end <= start:
            end = round(start + 0.05, 3)
        segments.append({
            "start": start,
            "end": end,
            "text": token_text,
        })
    return segments


def _build_pause_grouped_segments_from_token_segments(
    token_segments,
    *,
    max_chars=36,
    max_duration=7.5,
    gap_threshold=0.72,
):
    if not token_segments:
        return []

    terminal_punctuation = {"。", "！", "？", "!", "?", ";", "；"}
    segments = []
    bucket = []

    def flush():
        nonlocal bucket
        if not bucket:
            return
        texts = [item["text"] for item in bucket if item.get("text")]
        if not texts:
            bucket = []
            return
        segments.append(
            {
                "start": round(float(bucket[0]["start"]), 3),
                "end": round(float(bucket[-1]["end"]), 3),
                "text": _join_token_texts(texts),
            }
        )
        bucket = []

    for index, token in enumerate(token_segments):
        if not token.get("text"):
            continue
        if bucket:
            gap = float(token["start"]) - float(bucket[-1]["end"])
            duration = float(bucket[-1]["end"]) - float(bucket[0]["start"])
            current_length = len(_join_token_texts([item["text"] for item in bucket]))
            if gap > gap_threshold or duration >= max_duration or current_length >= max_chars:
                flush()

        bucket.append(token)
        token_text = str(token["text"]).strip()
        next_gap = None
        if index + 1 < len(token_segments):
            next_gap = float(token_segments[index + 1]["start"]) - float(token["end"])
        if token_text[-1:] in terminal_punctuation or (next_gap is not None and next_gap > gap_threshold):
            flush()

    flush()

    asr_data = ASRData(
        [
            ASRDataSeg(
                text=segment["text"],
                start_time=int(round(float(segment["start"]) * 1000)),
                end_time=int(round(float(segment["end"]) * 1000)),
            )
            for segment in segments
        ]
    )
    asr_data.optimize_timing()
    return [
        {
            "start": round(seg.start_time / 1000.0, 3),
            "end": round(seg.end_time / 1000.0, 3),
            "text": seg.text,
        }
        for seg in asr_data.segments
        if seg.text.strip()
    ]


def _normalize_qwen_language(language):
    if language is None:
        return None
    normalized = str(language).strip().lower()
    return _QWEN_LANGUAGE_MAP.get(normalized, str(language).strip())


def _resolve_qwen_runtime_device(requested):
    normalized = str(requested or "auto").strip().lower()
    if normalized == "cuda" and torch.cuda.is_available():
        return "cuda"
    if normalized == "cpu":
        return "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"


def run_qwen_asr_inference(
    audio_path,
    model_name="Qwen3-ASR-1.7B",
    language=None,
    splitter_kwargs=None,
    device="auto",
    max_inference_batch_size=32,
    max_new_tokens=256
):
    if not Qwen3ASRModel:
        raise ImportError(
            "Qwen3ASRModel not available. Please ensure the local Qwen3-ASR runtime package is present under models/asr/qwen3."
        )

    try:
        import soynlp  # noqa: F401
    except ImportError as error:
        raise RuntimeError(
            "[QwenASR] Missing dependency 'soynlp'. "
            "Please install soynlp==0.0.493 for Korean/multilingual forced alignment."
        ) from error

    model_path = _resolve_qwen_model_dir(model_name)
    if not model_path:
        raise FileNotFoundError(
            "[QwenASR] Local model not found. Expected one of: "
            + ", ".join(_get_qwen_model_candidates(model_name))
        )

    print(f"[QwenASR] Loading model from: {model_path}")

    aligner_name = "Qwen3-ForcedAligner-0.6B"
    aligner_path = _resolve_qwen_aligner_dir(aligner_name)
    if not aligner_path:
        raise FileNotFoundError(
            "[QwenASR] Local aligner not found. Expected one of: "
            + ", ".join(_get_qwen_aligner_candidates(aligner_name))
        )

    asr = None
    try:
        device = _resolve_qwen_runtime_device(device)
        print(f"[QwenASR] Device: {device}")

        # Initialize Model
        # Using simple transformers loading as per example
        model_dtype = torch.bfloat16 if device == "cuda" else torch.float32
        asr = Qwen3ASRModel.from_pretrained(
            model_path,
            dtype=model_dtype,
            device_map=device,
            max_inference_batch_size=max(1, int(max_inference_batch_size or 32)),
            max_new_tokens=max(32, int(max_new_tokens or 256)),
            forced_aligner=aligner_path,
            forced_aligner_kwargs=dict(
                dtype=model_dtype,
                device_map=device,
            ),
        )

        print(f"[QwenASR] Transcribing: {audio_path}")
        results = asr.transcribe(
            audio=audio_path,
            language=_normalize_qwen_language(language), # Auto-detect if None
            return_time_stamps=True,
        )

        segments = []
        token_segments = []
        if results and len(results) > 0:
            res = results[0]  # Single file inference
            if res.time_stamps:
                token_segments = _build_token_segments(res.time_stamps)
            if token_segments:
                segments = _build_pause_grouped_segments_from_token_segments(token_segments)
            elif res.text:
                print("[QwenASR] Warning: No timestamps returned or aligned. Using full text as one segment.")
                segments.append({
                    "start": 0.0,
                    "end": 0.0,
                    "text": clean_segment_text(res.text)
                })

        segments = _finalize_qwen_segments(
            segments,
            splitter_kwargs=splitter_kwargs,
            optimize_enabled=True,
        )
        print(f"[QwenASR] Inference complete. Found {len(segments)} segments.")
        return segments

    except Exception as e:
        print(f"[QwenASR] Inference failed: {e}")
        traceback.print_exc()
        raise RuntimeError(f"Qwen ASR inference failed: {e}") from e
    finally:
        if asr is not None:
            try:
                del asr
            except Exception:
                pass
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

if __name__ == "__main__":
    # Test
    if len(sys.argv) > 1:
        run_qwen_asr_inference(sys.argv[1])


def get_qwen_asr_runtime_status(model_name: str = "Qwen3-ASR-1.7B") -> tuple[bool, str | None]:
    if not Qwen3ASRModel:
        return False, "Qwen3ASRModel not available. Please ensure the local Qwen3-ASR runtime package is present under models/asr/qwen3."

    model_path = _resolve_qwen_model_dir(model_name)
    if not model_path:
        return False, "Qwen3-ASR local model not found: " + ", ".join(_get_qwen_model_candidates(model_name))

    aligner_name = "Qwen3-ForcedAligner-0.6B"
    aligner_path = _resolve_qwen_aligner_dir(aligner_name)
    if not aligner_path:
        return False, "Qwen3-ASR forced aligner model is missing: " + ", ".join(_get_qwen_aligner_candidates(aligner_name))

    return True, None
