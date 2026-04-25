
import os
import sys
import torch
import traceback
import re
import logging
from app_logging import get_logger, redirect_print

# Force strict offline mode
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'

logger = get_logger("asr.qwen")
print = redirect_print(logger, default_level=logging.DEBUG)

# Setup FFmpeg path for portable environment
current_dir = os.path.dirname(os.path.abspath(__file__))
ffmpeg_bin = os.path.join(current_dir, "ffmpeg", "bin")
if os.path.exists(os.path.join(ffmpeg_bin, "ffmpeg.exe")):
    if ffmpeg_bin not in os.environ.get("PATH", ""):
        os.environ["PATH"] = ffmpeg_bin + os.pathsep + os.environ.get("PATH", "")
        print(f"[QwenASR] Added FFmpeg to PATH: {ffmpeg_bin}")


# Ensure environment requirements
try:
    from dependency_manager import ensure_package_installed, ensure_transformers_version
    ensure_transformers_version("4.57.3")
    ensure_package_installed("soynlp", "soynlp==0.0.493")
except ImportError:
    print("[QwenASR] Dependency manager not found, skipping version check.")

# Add Qwen3-ASR submodule to path
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(current_dir)
qwen_repo_path = os.path.join(project_root, "Qwen3-ASR")

if os.path.exists(qwen_repo_path) and qwen_repo_path not in sys.path:
    print(f"[QwenASR] Adding {qwen_repo_path} to sys.path")
    sys.path.insert(0, qwen_repo_path)

try:
    from qwen_asr import Qwen3ASRModel
except ImportError as e:
    print(f"[QwenASR] Warning: Could not import qwen_asr: {e}")
    Qwen3ASRModel = None


_COMMON_ABBREVIATIONS = {
    "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "vs.", "etc.",
    "e.g.", "i.e.", "u.s.", "u.k.", "p.s."
}

_CODE_SUFFIX_RE = re.compile(r"^[a-z0-9_+-]+\.(js|ts|tsx|jsx|py|java|go|rs|cpp|c|cs|php|rb|swift|kt|scala|net|ai|io)$", re.IGNORECASE)
_ACRONYM_RE = re.compile(r"^(?:[a-z]\.){2,}[a-z]?$", re.IGNORECASE)


def _normalize_text(value):
    return re.sub(r"[^\w\u4e00-\u9fff]", "", value).lower()


def _join_token_texts(token_texts):
    joined = "".join(token_texts)
    has_cjk = any('\u4e00' <= char <= '\u9fff' for char in joined)
    return joined if has_cjk else " ".join(token_texts)


def _estimate_text_length(token_slice):
    return len(_join_token_texts([token.text.strip() for token in token_slice if token.text.strip()]))


def _extract_dot_token(text, index):
    start = index
    end = index
    while start > 0 and not text[start - 1].isspace():
        start -= 1
    while end + 1 < len(text) and not text[end + 1].isspace():
        end += 1
    return text[start:end + 1]


def _is_non_terminal_period(text, index):
    prev_char = text[index - 1] if index > 0 else ""
    next_char = text[index + 1] if index + 1 < len(text) else ""

    if prev_char.isdigit() and next_char.isdigit():
        return True

    if prev_char.isalpha() and next_char.isalpha():
        return True

    token = _extract_dot_token(text, index).strip("()[]{}<>\"'")
    token_lower = token.lower()
    if token_lower in _COMMON_ABBREVIATIONS:
        return True
    if _CODE_SUFFIX_RE.match(token):
        return True
    if _ACRONYM_RE.match(token_lower):
        return True

    return False


def _split_text_into_sentences(text):
    sentences = []
    start = 0
    i = 0
    terminal_punctuation = {'。', '！', '？', '!', '?', ';', '；'}

    while i < len(text):
        ch = text[i]
        is_boundary = False

        if ch in terminal_punctuation:
            is_boundary = True
        elif ch == '\n':
            is_boundary = True
        elif ch == '.':
            is_boundary = not _is_non_terminal_period(text, i)

        if is_boundary:
            segment = text[start:i + 1].strip()
            if segment:
                sentences.append(segment)
            start = i + 1
        i += 1

    tail = text[start:].strip()
    if tail:
        sentences.append(tail)
    return sentences


def _consume_sentence_tokens(sentence_text, tokens, start_index):
    norm_sentence = _normalize_text(sentence_text)
    if not norm_sentence:
        return None

    built = ""
    sent_start = None
    sent_end = None
    token_index = start_index

    while token_index < len(tokens):
        token = tokens[token_index]
        norm_token = _normalize_text(token.text)

        if not norm_token:
            token_index += 1
            continue

        candidate = built + norm_token
        if not norm_sentence.startswith(candidate):
            return None

        if sent_start is None:
            sent_start = token.start_time
        sent_end = token.end_time
        built = candidate
        token_index += 1

        if built == norm_sentence:
            return {
                "token_start_index": start_index,
                "next_token_index": token_index,
                "start": round(sent_start, 3),
                "end": round(sent_end, 3),
                "text": sentence_text
            }

    return None


def _fallback_segment_tokens(tokens, start_index, end_index=None, max_chars=80, max_duration=8.0, gap_threshold=0.8):
    segments = []
    idx = start_index
    stop_index = len(tokens) if end_index is None else min(end_index, len(tokens))

    while idx < stop_index:
        chunk_texts = []
        chunk_start = None
        chunk_end = None
        last_end = None

        while idx < stop_index:
            token = tokens[idx]
            token_text = token.text.strip()
            if not token_text:
                idx += 1
                continue

            if chunk_start is None:
                chunk_start = token.start_time
            else:
                gap = token.start_time - (last_end if last_end is not None else token.start_time)
                current_text_len = len(_join_token_texts(chunk_texts))
                current_duration = (chunk_end - chunk_start) if chunk_end is not None else 0.0
                if gap > gap_threshold or current_text_len >= max_chars or current_duration >= max_duration:
                    break

            chunk_texts.append(token_text)
            chunk_end = token.end_time
            last_end = token.end_time
            idx += 1

        if chunk_texts and chunk_start is not None and chunk_end is not None:
            segments.append({
                "start": round(chunk_start, 3),
                "end": round(chunk_end, 3),
                "text": _join_token_texts(chunk_texts)
            })
        else:
            idx += 1

    return segments


def _segment_is_oversized(segment, tokens):
    token_slice = tokens[segment["token_start_index"]:segment["next_token_index"]]
    duration = segment["end"] - segment["start"]
    text_length = _estimate_text_length(token_slice)
    return duration > 14.0 or text_length > 160

def run_qwen_asr_inference(audio_path, model_name="Qwen3-ASR-1.7B", language=None):
    if not Qwen3ASRModel:
        raise ImportError("Qwen3ASRModel not available. Please ensure Qwen3-ASR submodule is present.")

    try:
        import soynlp  # noqa: F401
    except ImportError as error:
        raise RuntimeError(
            "[QwenASR] Missing dependency 'soynlp'. "
            "Please install soynlp==0.0.493 for Korean/multilingual forced alignment."
        ) from error

    # Resolve Model Path
    # Check local models/ folder
    models_dir = os.path.join(project_root, "models")
    model_path = os.path.join(models_dir, model_name)
    
    # Try alternate location if not found (e.g. inside models/Qwen)
    if not os.path.exists(model_path):
        alt_path = os.path.join(models_dir, "Qwen", model_name)
        if os.path.exists(alt_path):
             model_path = alt_path
    
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"[QwenASR] Local model not found at {model_path}. Please download it to 'models/{model_name}'")

    print(f"[QwenASR] Loading model from: {model_path}")

    # Resolve Forced Aligner Path
    aligner_name = "Qwen3-ForcedAligner-0.6B"
    aligner_path = os.path.join(models_dir, aligner_name)
    if not os.path.exists(aligner_path):
         aligner_path = os.path.join(models_dir, "Qwen", aligner_name)
    
    if not os.path.exists(aligner_path):
        # Optional: Try same dir as main model?
        # For now, strict fail or warning? Let's strict fail to be safe as user requested local only.
        print(f"[QwenASR] Warning: Local aligner not found at {aligner_path}. Timestamps might aid alignment.")
        # We can try to proceed without aligner if the model allows, but Qwen3 ASR usually needs it for timestamps?
        # Actually example shows it's passed. If missing, code might fail.
        # But let's error out to be consistent with "Always load from local"
        raise FileNotFoundError(f"[QwenASR] Local aligner not found at {aligner_path}. Please download it.")

    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"[QwenASR] Device: {device}")

        # Initialize Model
        # Using simple transformers loading as per example
        asr = Qwen3ASRModel.from_pretrained(
            model_path,
            dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
            device_map=device,
            forced_aligner=aligner_path,
            forced_aligner_kwargs=dict(
                dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
                device_map=device,
            ),
        )

        print(f"[QwenASR] Transcribing: {audio_path}")
        results = asr.transcribe(
            audio=audio_path,
            language=language, # Auto-detect if None
            return_time_stamps=True,
        )

        # DEBUG: Save raw model output for inspection
        try:
            import json
            raw_data = []
            for r in results:
                items = []
                if r.time_stamps:
                    for ts in r.time_stamps:
                        items.append({
                            "text": ts.text,
                            "start": ts.start_time,
                            "end": ts.end_time
                        })
                raw_data.append({
                    "language": r.language,
                    "text": r.text,
                    "time_stamps": items
                })
            debug_path = audio_path + ".raw_asr.json"
            with open(debug_path, "w", encoding="utf-8") as f:
                json.dump(raw_data, f, ensure_ascii=False, indent=2)
            print(f"[QwenASR] Raw output saved to: {debug_path}")
        except Exception as e:
            print(f"[QwenASR] Failed to save debug output: {e}")

        # Convert results to standard format: [{'start': s, 'end': e, 'text': t}]
        segments = []
        if results and len(results) > 0:
            res = results[0]  # Single file inference
            if res.time_stamps and res.text:
                full_text = res.text
                tokens = res.time_stamps
                refined_sentences = _split_text_into_sentences(full_text)

                token_idx = 0
                sent_idx = 0
                max_sentence_merge = 4

                while sent_idx < len(refined_sentences) and token_idx < len(tokens):
                    matched_segment = None
                    merge_count = 1

                    while merge_count <= max_sentence_merge and sent_idx + merge_count <= len(refined_sentences):
                        merged_sentence = " ".join(refined_sentences[sent_idx:sent_idx + merge_count]).strip()
                        attempt = _consume_sentence_tokens(merged_sentence, tokens, token_idx)
                        if attempt:
                            matched_segment = attempt
                            break
                        merge_count += 1

                    if matched_segment:
                        if _segment_is_oversized(matched_segment, tokens):
                            print(f"[QwenASR] Warning: Oversized aligned segment '{matched_segment['text'][:30]}...' detected ({matched_segment['end'] - matched_segment['start']:.2f}s). Splitting by token timing.")
                            segments.extend(
                                _fallback_segment_tokens(
                                    tokens,
                                    matched_segment["token_start_index"],
                                    end_index=matched_segment["next_token_index"]
                                )
                            )
                        else:
                            segments.append({
                                "start": matched_segment["start"],
                                "end": matched_segment["end"],
                                "text": matched_segment["text"]
                            })
                        token_idx = matched_segment["next_token_index"]
                        sent_idx += merge_count
                        continue

                    print(f"[QwenASR] Warning: Sentence '{refined_sentences[sent_idx][:30]}...' could not be aligned at token index {token_idx}. Falling back to token chunking for the remaining audio.")
                    segments.extend(_fallback_segment_tokens(tokens, token_idx))
                    token_idx = len(tokens)
                    break

                if token_idx < len(tokens):
                    print(f"[QwenASR] Warning: {len(tokens) - token_idx} leftover tokens remained after sentence alignment. Applying fallback chunking.")
                    segments.extend(_fallback_segment_tokens(tokens, token_idx))

            elif res.text:
                # Fallback if no timestamps returned
                print("[QwenASR] Warning: No timestamps returned or aligned. Using full text as one segment.")
                segments.append({
                    "start": 0.0,
                    "end": 0.0,
                    "text": res.text
                })
        
        print(f"[QwenASR] Inference complete. Found {len(segments)} segments.")
        return segments

    except Exception as e:
        print(f"[QwenASR] Inference failed: {e}")
        traceback.print_exc()
        raise RuntimeError(f"Qwen ASR inference failed: {e}") from e

if __name__ == "__main__":
    # Test
    if len(sys.argv) > 1:
        run_qwen_asr_inference(sys.argv[1])
