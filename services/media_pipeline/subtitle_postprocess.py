from __future__ import annotations

import logging
import re
from collections.abc import Callable, Iterable

from app_logging import get_logger
from subtitle_optimizer import optimize_subtitle_segments
from subtitle_splitter import split_subtitle_segments

logger = get_logger("subtitle.postprocess")

SegmentTextNormalizer = Callable[[str], str]
OPTIONAL_SEGMENT_KEYS = (
    "speaker",
    "speaker_id",
    "utterance",
    "utterance_id",
    "utterance_index",
    "provider",
    "provider_meta",
)


def clean_segment_text(text) -> str:
    cleaned = re.sub(r"\s+", " ", str(text or "")).strip()
    return cleaned.strip("~～﹌`")


def filter_hallucination_segments(
    segments: list[dict],
    *,
    hallucination_keywords: Iterable[str] = (),
) -> list[dict]:
    filtered = []
    keywords = tuple(hallucination_keywords or ())
    for seg in segments or []:
        text = str(seg.get("text", "")).strip()
        if not text:
            continue
        if text.startswith(("【", "[", "(", "（")):
            continue
        if keywords and any(keyword in text for keyword in keywords):
            continue
        filtered.append(seg)
    return filtered


def normalize_output_segments(
    segments: list[dict],
    *,
    hallucination_keywords: Iterable[str] = (),
) -> list[dict]:
    normalized = []
    for seg in segments or []:
        text = clean_segment_text(seg.get("text", ""))
        if not text:
            continue
        start = round(float(seg.get("start", 0.0)), 3)
        end = round(float(seg.get("end", start)), 3)
        if end <= start:
            end = round(start + 0.05, 3)
        normalized_segment = {
            "start": start,
            "end": end,
            "text": text,
        }
        for key in OPTIONAL_SEGMENT_KEYS:
            if key in seg and seg.get(key) is not None:
                normalized_segment[key] = seg.get(key)
        normalized.append(normalized_segment)
    return filter_hallucination_segments(normalized, hallucination_keywords=hallucination_keywords)


def apply_segment_text_normalizer(
    segments: list[dict],
    text_normalizer: SegmentTextNormalizer | None,
) -> list[dict]:
    if text_normalizer is None:
        return segments

    normalized = []
    for seg in segments or []:
        updated = dict(seg)
        updated["text"] = text_normalizer(str(seg.get("text", "") or ""))
        normalized.append(updated)
    return normalized


def finalize_subtitle_segments(
    sentence_segments: list[dict],
    *,
    splitter_source: list[dict] | None = None,
    splitter_kwargs: dict | None = None,
    apply_splitter: bool = True,
    optimize_enabled: bool = True,
    hallucination_keywords: Iterable[str] = (),
    text_normalizer: SegmentTextNormalizer | None = None,
) -> list[dict]:
    final_segments = normalize_output_segments(
        sentence_segments,
        hallucination_keywords=hallucination_keywords,
    )

    if apply_splitter:
        split_input = splitter_source or sentence_segments or []
        split_output = split_subtitle_segments(split_input, splitter_kwargs=splitter_kwargs) or final_segments
        final_segments = normalize_output_segments(
            split_output,
            hallucination_keywords=hallucination_keywords,
        )

    if optimize_enabled and final_segments:
        try:
            optimized = optimize_subtitle_segments(final_segments, optimizer_kwargs=splitter_kwargs)
            final_segments = normalize_output_segments(
                optimized,
                hallucination_keywords=hallucination_keywords,
            )
        except Exception as error:
            logger.warning("Subtitle optimize failed inside postprocess pipeline: %s", error)

    final_segments = apply_segment_text_normalizer(final_segments, text_normalizer)
    return normalize_output_segments(
        final_segments,
        hallucination_keywords=hallucination_keywords,
    )
