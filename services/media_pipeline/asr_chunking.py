import difflib
import os
import tempfile
from typing import List, Optional, Tuple

from pydub import AudioSegment

DEFAULT_CHUNK_LENGTH_SEC = 60 * 20
DEFAULT_CHUNK_OVERLAP_SEC = 10


def get_audio_duration_seconds(audio_path: str) -> float:
    try:
        audio = AudioSegment.from_file(audio_path)
        return max(0.0, float(len(audio)) / 1000.0)
    except Exception:
        try:
            import librosa

            return float(librosa.get_duration(path=audio_path))
        except Exception:
            return 0.0


def split_audio_file(
    audio_path: str,
    chunk_length_sec: int = DEFAULT_CHUNK_LENGTH_SEC,
    chunk_overlap_sec: int = DEFAULT_CHUNK_OVERLAP_SEC,
) -> Tuple[List[Tuple[str, float]], tempfile.TemporaryDirectory]:
    temp_dir = tempfile.TemporaryDirectory(prefix="asr_chunks_")
    try:
        audio = AudioSegment.from_file(audio_path)
    except Exception:
        import librosa
        import numpy as np
        import soundfile as sf

        waveform, sample_rate = librosa.load(audio_path, sr=None, mono=False)
        if getattr(waveform, "ndim", 1) == 1:
            waveform = np.expand_dims(waveform, axis=0)
        waveform = waveform.T
        temp_dir = tempfile.TemporaryDirectory(prefix="asr_chunks_")
        total_samples = waveform.shape[0]
        chunk_length_samples = int(chunk_length_sec * sample_rate)
        chunk_overlap_samples = int(chunk_overlap_sec * sample_rate)

        chunks: List[Tuple[str, float]] = []
        start_sample = 0
        index = 0
        while start_sample < total_samples:
            end_sample = min(start_sample + chunk_length_samples, total_samples)
            chunk_path = os.path.join(temp_dir.name, f"chunk_{index:03d}.wav")
            sf.write(chunk_path, waveform[start_sample:end_sample], sample_rate)
            chunks.append((chunk_path, start_sample / float(sample_rate)))
            if end_sample >= total_samples:
                break
            start_sample += max(sample_rate, chunk_length_samples - chunk_overlap_samples)
            index += 1

        return chunks, temp_dir
    total_duration_ms = len(audio)
    chunk_length_ms = int(chunk_length_sec * 1000)
    chunk_overlap_ms = int(chunk_overlap_sec * 1000)

    chunks: List[Tuple[str, float]] = []
    start_ms = 0
    index = 0
    while start_ms < total_duration_ms:
        end_ms = min(start_ms + chunk_length_ms, total_duration_ms)
        chunk = audio[start_ms:end_ms]
        chunk_path = os.path.join(temp_dir.name, f"chunk_{index:03d}.wav")
        chunk.export(chunk_path, format="wav")
        chunks.append((chunk_path, start_ms / 1000.0))

        if end_ms >= total_duration_ms:
            break
        start_ms += max(1000, chunk_length_ms - chunk_overlap_ms)
        index += 1

    return chunks, temp_dir


def merge_chunk_segments(
    chunks: List[List[dict]],
    chunk_offsets: Optional[List[float]] = None,
    overlap_duration: float = DEFAULT_CHUNK_OVERLAP_SEC,
) -> List[dict]:
    if not chunks:
        return []
    if len(chunks) == 1:
        return chunks[0]

    is_word_level = any(_is_word_level_segments(chunk) for chunk in chunks if chunk)
    if chunk_offsets is None:
        chunk_offsets = _infer_chunk_offsets(chunks, overlap_duration)

    adjusted_chunks = [
        _adjust_timestamps(chunk, offset)
        for chunk, offset in zip(chunks, chunk_offsets)
    ]

    merged = adjusted_chunks[0]
    for index in range(1, len(adjusted_chunks)):
        merged = _merge_two_sequences(merged, adjusted_chunks[index], overlap_duration, is_word_level)
    return merged


def _normalize_text(text: str) -> str:
    return " ".join(str(text or "").strip().lower().split())


def _is_word_level_text(text: str) -> bool:
    value = str(text or "").strip()
    if not value:
        return False
    cjk_count = sum(1 for char in value if "\u4e00" <= char <= "\u9fff")
    total_count = sum(1 for char in value if char.strip())
    if total_count == 0:
        return False
    if cjk_count / total_count > 0.5:
        return len(value) <= 2
    return len(value.split()) == 1


def _is_word_level_segments(segments: List[dict]) -> bool:
    if not segments:
        return False
    word_count = sum(1 for seg in segments if _is_word_level_text(seg.get("text", "")))
    return (word_count / len(segments)) >= 0.8


def _adjust_timestamps(segments: List[dict], offset: float) -> List[dict]:
    adjusted = []
    for seg in segments:
        adjusted.append({
            "start": round(float(seg.get("start", 0.0)) + offset, 3),
            "end": round(float(seg.get("end", 0.0)) + offset, 3),
            "text": str(seg.get("text", "")),
        })
    return adjusted


def _extract_overlap_segments(segments: List[dict], from_end: bool, duration: float) -> List[dict]:
    if not segments:
        return []

    overlap: List[dict] = []
    if from_end:
        threshold = float(segments[-1].get("end", 0.0)) - duration
        for seg in reversed(segments):
            if float(seg.get("start", 0.0)) >= threshold:
                overlap.insert(0, seg)
            else:
                break
    else:
        threshold = float(segments[0].get("start", 0.0)) + duration
        for seg in segments:
            if float(seg.get("end", 0.0)) <= threshold:
                overlap.append(seg)
            else:
                break
    return overlap


def _find_best_alignment(left: List[dict], right: List[dict], is_word_level: bool):
    left_len = len(left)
    right_len = len(right)
    best_score = 0.0
    best_result = None

    for index in range(1, left_len + right_len + 1):
        epsilon = float(index) / 10000.0
        left_start = max(0, left_len - index)
        left_end = min(left_len, left_len + right_len - index)
        right_start = max(0, index - left_len)
        right_end = min(right_len, index)

        left_slice = left[left_start:left_end]
        right_slice = right[right_start:right_end]
        if len(left_slice) != len(right_slice):
            continue

        if is_word_level:
            matches = sum(
                1
                for left_seg, right_seg in zip(left_slice, right_slice)
                if _normalize_text(left_seg.get("text", "")) == _normalize_text(right_seg.get("text", ""))
            )
        else:
            matches = sum(
                1
                for left_seg, right_seg in zip(left_slice, right_slice)
                if difflib.SequenceMatcher(
                    None,
                    _normalize_text(left_seg.get("text", "")),
                    _normalize_text(right_seg.get("text", "")),
                ).ratio() > 0.7
            )

        score = matches / float(index) + epsilon
        if matches >= 2 and score > best_score:
            best_score = score
            best_result = (left_start, left_end, right_start, right_end, matches)

    return best_result


def _merge_two_sequences(left: List[dict], right: List[dict], overlap_duration: float, is_word_level: bool) -> List[dict]:
    if not left:
        return right
    if not right:
        return left

    left_len = len(left)
    left_overlap = _extract_overlap_segments(left, from_end=True, duration=overlap_duration)
    right_overlap = _extract_overlap_segments(right, from_end=False, duration=overlap_duration)
    if not left_overlap or not right_overlap:
        return left + right

    best_match = _find_best_alignment(left_overlap, right_overlap, is_word_level)
    if best_match is None:
        split_index = left_len
        right_start = float(right[0].get("start", 0.0))
        for index in range(left_len - 1, -1, -1):
            if float(left[index].get("end", 0.0)) <= right_start:
                split_index = index + 1
                break
        return left[:split_index] + right

    left_start_idx, left_end_idx, right_start_idx, right_end_idx, _matches = best_match
    left_mid = (left_start_idx + left_end_idx) // 2
    right_mid = (right_start_idx + right_end_idx) // 2
    left_overlap_offset = left_len - len(left_overlap)
    left_cut = left_overlap_offset + left_mid
    return left[:left_cut] + right[right_mid:]


def _infer_chunk_offsets(chunks: List[List[dict]], overlap_duration: float) -> List[float]:
    offsets = [0.0]
    for index in range(1, len(chunks)):
        prev_chunk = chunks[index - 1]
        if prev_chunk:
            prev_end = float(prev_chunk[-1].get("end", 0.0))
            next_offset = offsets[-1] + prev_end - overlap_duration
            offsets.append(max(next_offset, offsets[-1]))
        else:
            offsets.append(offsets[-1])
    return offsets
