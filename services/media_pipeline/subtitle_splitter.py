import atexit
import difflib
import importlib.util
import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Union

from app_logging import get_logger, redirect_print
from asr_data import ASRData, ASRDataSeg
from llm import LLMTranslator
from text_utils import count_words, is_mainly_cjk, is_pure_punctuation, is_space_separated_language

logger = get_logger("subtitle.splitter")
print = redirect_print(logger, default_level=logging.DEBUG)

MAX_WORD_COUNT_CJK = 28
MAX_WORD_COUNT_ENGLISH = 20
SEGMENT_WORD_THRESHOLD = 500
MAX_GAP = 1500
MERGE_SHORT_GAP = 200
MERGE_VERY_SHORT_GAP = 500
MERGE_MIN_WORDS = 5
MERGE_VERY_SHORT_WORDS = 3
SPLIT_SEARCH_RANGE = 30
TIME_GAP_WINDOW_SIZE = 5
TIME_GAP_MULTIPLIER = 3
MIN_GROUP_SIZE = 5
RULE_SPLIT_GAP = 500
RULE_MIN_SEGMENT_SIZE = 4
PREFIX_WORD_RATIO = 0.6
SUFFIX_WORD_RATIO = 0.4
MATCH_SIMILARITY_THRESHOLD = 0.5
MATCH_MAX_SHIFT = 30
MATCH_MAX_UNMATCHED = 5
MATCH_LARGE_SHIFT = 100
DEFAULT_SPLIT_MODEL = "gpt-4o-mini"
BOUNDARY_CONTINUATION_CHARS = {
    "户", "们", "者", "性", "化", "器", "式", "版", "率", "度",
    "线", "项", "感", "口", "库", "区", "群", "码", "点", "类",
}
BOUNDARY_PUNCTUATION = set("，。！？；：,.!?;:、)）]】>}》\"'")

SENTENCE_SPLIT_PROMPT = """You are a professional subtitle sentence segmentation expert.

Insert <br> at natural sentence pauses or semantic break points.

Instructions:
1. Insert <br> at sentence boundaries where punctuation such as periods, commas, or semicolons would naturally appear.
2. Segment length limits:
   - CJK languages: each segment must be <= {max_word_count_cjk} characters
   - Space-separated languages: each segment must be <= {max_word_count_english} words
3. Keep each segment semantically complete while respecting the limits.
4. Keep the original text unchanged. Do not add, remove, rewrite, or translate content. Only insert <br>.
5. Countdown numbers, reveal moments, and emphasis points may be split more aggressively when natural.
6. Never split inside a word, product name, version string, or mixed Chinese-English token. Avoid leaving a dangling continuation character at the start of a segment.

Output only the fully segmented text with <br> separators and nothing else."""


def preprocess_segments(segments: List[ASRDataSeg], need_lower: bool = True) -> List[ASRDataSeg]:
    new_segments = []
    for seg in segments:
        if is_pure_punctuation(seg.text):
            continue

        text = seg.text.strip()
        if is_space_separated_language(text):
            if need_lower:
                text = text.lower()
            seg.text = text + " "
        else:
            seg.text = text
        new_segments.append(seg)
    return new_segments


def _should_enable_llm(splitter_kwargs: dict | None) -> bool:
    splitter_kwargs = splitter_kwargs or {}
    if splitter_kwargs.get("enable_local_llm") in (True, "true", "1", 1):
        allow_local_llm = True
    else:
        allow_local_llm = False

    api_key = splitter_kwargs.get("api_key")
    base_url = splitter_kwargs.get("base_url")
    model = splitter_kwargs.get("model")
    model_dir = splitter_kwargs.get("model_dir")

    if api_key and base_url and model:
        return True

    if not allow_local_llm:
        return False

    if importlib.util.find_spec("accelerate") is None:
        return False

    if model_dir:
        return os.path.exists(model_dir)

    backend_dir = os.path.dirname(os.path.abspath(__file__))
    default_paths = [
        os.path.join(backend_dir, "..", "models", "Qwen2.5-7B-Instruct"),
        os.path.join(backend_dir, "..", "..", "models", "Qwen2.5-7B-Instruct"),
    ]
    return any(os.path.exists(path) for path in default_paths)


def split_by_llm(text: str, translator: LLMTranslator, max_word_count_cjk: int, max_word_count_english: int) -> List[str]:
    system_prompt = SENTENCE_SPLIT_PROMPT.format(
        max_word_count_cjk=max_word_count_cjk,
        max_word_count_english=max_word_count_english,
    )
    messages = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": f"Please use multiple <br> tags to separate the following sentence:\n{text}",
        },
    ]

    last_result = None
    for _ in range(2):
        response_text = translator.chat_complete(messages, temperature=0.1, max_new_tokens=1024)
        cleaned = re.sub(r"\n+", "", response_text)
        split_result = [segment.strip() for segment in cleaned.split("<br>") if segment.strip()]
        split_result = _repair_cjk_split_boundaries(split_result, max_word_count_cjk)
        last_result = split_result

        is_valid, error_message = _validate_split_result(
            original_text=text,
            split_result=split_result,
            max_word_count_cjk=max_word_count_cjk,
            max_word_count_english=max_word_count_english,
        )
        if is_valid:
            return split_result

        logger.warning("Split validation failed: %s", error_message)
        messages.append({"role": "assistant", "content": response_text})
        messages.append(
            {
                "role": "user",
                "content": (
                    "Error: "
                    + error_message
                    + "\nFix the errors and output the COMPLETE corrected text with <br> tags only."
                ),
            }
        )

    return last_result if last_result else [text]


def _validate_split_result(original_text: str, split_result: List[str], max_word_count_cjk: int, max_word_count_english: int):
    if not split_result:
        return False, "No segments found. Split the text with <br> tags."

    original_cleaned = re.sub(r"\s+", " ", original_text)
    text_is_cjk = is_mainly_cjk(original_cleaned)
    merged = ("" if text_is_cjk else " ").join(split_result)
    merged_cleaned = re.sub(r"\s+", " ", merged)

    matcher = difflib.SequenceMatcher(None, original_cleaned, merged_cleaned)
    similarity_ratio = matcher.ratio()
    if similarity_ratio < 0.96:
        return False, f"Content modified too much (similarity: {similarity_ratio:.1%}). Keep original text unchanged."

    max_allowed = max_word_count_cjk if text_is_cjk else max_word_count_english
    violations = []
    for index, segment in enumerate(split_result, 1):
        word_count = count_words(segment)
        if word_count > max_allowed:
            violations.append(f"Segment {index} has {word_count} units, limit is {max_allowed}.")

    if violations:
        return False, " ".join(violations)
    return True, ""


def _repair_cjk_split_boundaries(split_result: List[str], max_word_count_cjk: int) -> List[str]:
    if len(split_result) < 2:
        return split_result

    repaired = [segment for segment in split_result if segment]
    index = 0
    while index < len(repaired) - 1:
        current = repaired[index]
        nxt = repaired[index + 1]
        if not current or not nxt:
            index += 1
            continue

        if not is_mainly_cjk(current + nxt):
            index += 1
            continue

        current_tail = current[-1]
        next_head = nxt[0]
        if current_tail in BOUNDARY_PUNCTUATION or next_head in BOUNDARY_PUNCTUATION:
            index += 1
            continue

        if next_head in BOUNDARY_CONTINUATION_CHARS and count_words(current + next_head) <= max_word_count_cjk:
            repaired[index] = current + next_head
            repaired[index + 1] = nxt[1:]
            if not repaired[index + 1]:
                repaired.pop(index + 1)
                continue

        index += 1

    return [segment for segment in repaired if segment]


class SubtitleSplitter:
    def __init__(
        self,
        translator: LLMTranslator | None,
        thread_num: int = 1,
        model: str = DEFAULT_SPLIT_MODEL,
        max_word_count_cjk: int = MAX_WORD_COUNT_CJK,
        max_word_count_english: int = MAX_WORD_COUNT_ENGLISH,
    ):
        self.translator = translator
        self.thread_num = max(1, int(thread_num))
        self.model = model
        self.max_word_count_cjk = max_word_count_cjk
        self.max_word_count_english = max_word_count_english
        self.is_running = True
        self.executor = ThreadPoolExecutor(max_workers=self.thread_num)
        atexit.register(self.stop)

    def split_subtitle(self, subtitle_data: Union[str, ASRData]) -> ASRData:
        try:
            if isinstance(subtitle_data, str):
                asr_data = ASRData.from_subtitle_file(subtitle_data)
            else:
                asr_data = subtitle_data

            if not asr_data.is_word_timestamp():
                asr_data = asr_data.split_to_word_segments()

            asr_data.segments = preprocess_segments(asr_data.segments, need_lower=False)
            txt = asr_data.to_txt().replace("\n", "")
            total_word_count = count_words(txt)
            num_segments = self._determine_num_segments(total_word_count)
            logger.debug(
                "Based on word count %s, determined segment count: %s",
                total_word_count,
                num_segments,
            )

            asr_data_list = self._split_asr_data(asr_data, num_segments)
            processed_segments = self._process_segments(asr_data_list)
            final_segments = self._merge_processed_segments(processed_segments)
            return ASRData(final_segments)
        except Exception as error:
            logger.error("Split failed: %s", error)
            raise RuntimeError(f"Split failed: {error}") from error

    def _determine_num_segments(self, word_count: int, threshold: int = SEGMENT_WORD_THRESHOLD) -> int:
        num_segments = word_count // threshold
        if word_count % threshold > 0:
            num_segments += 1
        return max(1, num_segments)

    def _split_asr_data(self, asr_data: ASRData, num_segments: int) -> List[ASRData]:
        total_segs = len(asr_data.segments)
        total_word_count = count_words(asr_data.to_txt())
        words_per_segment = max(1, total_word_count // max(1, num_segments))

        if num_segments <= 1 or total_segs <= num_segments:
            return [asr_data]

        split_indices = [i * words_per_segment for i in range(1, num_segments)]
        adjusted_split_indices = []
        for split_point in split_indices:
            start = max(0, split_point - SPLIT_SEARCH_RANGE)
            end = min(total_segs - 1, split_point + SPLIT_SEARCH_RANGE)
            max_gap = -1.0
            best_index = min(split_point, total_segs - 1)

            for idx in range(start, end):
                gap = asr_data.segments[idx + 1].start_time - asr_data.segments[idx].end_time
                if gap > max_gap:
                    max_gap = gap
                    best_index = idx
            adjusted_split_indices.append(best_index)

        adjusted_split_indices = sorted(set(adjusted_split_indices))
        parts = []
        prev_index = 0
        for index in adjusted_split_indices:
            parts.append(ASRData(asr_data.segments[prev_index:index + 1]))
            prev_index = index + 1
        if prev_index < total_segs:
            parts.append(ASRData(asr_data.segments[prev_index:]))
        return parts

    def _process_segments(self, asr_data_list: List[ASRData]) -> List[List[ASRDataSeg]]:
        futures = []
        for asr_data in asr_data_list:
            if self.executor is None:
                raise ValueError("Thread pool not initialized")
            futures.append(self.executor.submit(self._process_single_segment, asr_data))

        processed_segments = []
        for future in as_completed(futures):
            if not self.is_running:
                break
            try:
                processed_segments.append(future.result())
            except Exception as error:
                logger.error("Segment processing failed: %s", error)
        return processed_segments

    def _process_single_segment(self, asr_data_part: ASRData) -> List[ASRDataSeg]:
        if not asr_data_part.segments:
            return []
        if not self.translator:
            return self._process_by_rules(asr_data_part.segments)
        try:
            return self._process_by_llm(asr_data_part.segments)
        except Exception as error:
            logger.warning("LLM processing failed, falling back to rules: %s", error)
            return self._process_by_rules(asr_data_part.segments)

    def _process_by_llm(self, segments: List[ASRDataSeg]) -> List[ASRDataSeg]:
        if not self.translator:
            raise RuntimeError("Splitter translator is not available.")

        text = "".join(seg.text for seg in segments)
        logger.debug("Calling API for segmentation, text length: %s", count_words(text))
        sentences = split_by_llm(
            text=text,
            translator=self.translator,
            max_word_count_cjk=self.max_word_count_cjk,
            max_word_count_english=self.max_word_count_english,
        )
        return self._merge_segments_based_on_sentences(segments, sentences)

    def _process_by_rules(self, segments: List[ASRDataSeg]) -> List[ASRDataSeg]:
        logger.debug("Segments: %s", len(segments))
        segment_groups = self._group_by_time_gaps(segments, max_gap=RULE_SPLIT_GAP, check_large_gaps=True)
        logger.debug("Grouped by time gaps: %s", len(segment_groups))
        common_result_groups = []
        for group in segment_groups:
            max_word_count = self.max_word_count_cjk if is_mainly_cjk("".join(seg.text for seg in group)) else self.max_word_count_english
            if count_words("".join(seg.text for seg in group)) > max_word_count:
                common_result_groups.extend(self._split_by_common_words(group))
            else:
                common_result_groups.append(group)

        result_segments = []
        for group in common_result_groups:
            result_segments.extend(self._split_long_segment(group))
        return result_segments

    def _group_by_time_gaps(self, segments: List[ASRDataSeg], max_gap: float = MAX_GAP, check_large_gaps: bool = False):
        if not segments:
            return []

        result = []
        current_group = [segments[0]]
        recent_gaps = []

        for idx in range(1, len(segments)):
            time_gap = segments[idx].start_time - segments[idx - 1].end_time
            if check_large_gaps:
                recent_gaps.append(time_gap)
                if len(recent_gaps) > TIME_GAP_WINDOW_SIZE:
                    recent_gaps.pop(0)
                if len(recent_gaps) == TIME_GAP_WINDOW_SIZE:
                    avg_gap = sum(recent_gaps) / len(recent_gaps)
                    if time_gap > avg_gap * TIME_GAP_MULTIPLIER and len(current_group) > MIN_GROUP_SIZE:
                        result.append(current_group)
                        current_group = []
                        recent_gaps = []

            if time_gap > max_gap:
                result.append(current_group)
                current_group = []
                recent_gaps = []

            current_group.append(segments[idx])

        if current_group:
            result.append(current_group)
        return result

    def _split_by_common_words(self, segments: List[ASRDataSeg]):
        prefix_split_words = {
            "and", "or", "but", "if", "then", "because", "as", "until", "while",
            "what", "when", "where", "nor", "yet", "so", "for", "however", "moreover",
            "和", "及", "与", "但", "而", "或", "因", "我", "你", "他", "她", "它", "咱",
            "您", "这", "那", "哪",
        }
        suffix_split_words = {
            ".", ",", "!", "?", "。", "，", "！", "？", "的", "了", "着", "过", "吗",
            "呢", "吧", "啊", "呀", "嘛", "啦", "mine", "yours", "hers", "its", "ours",
            "theirs", "either", "neither",
        }

        result = []
        current_group = []
        for index, seg in enumerate(segments):
            max_word_count = self.max_word_count_cjk if is_mainly_cjk(seg.text) else self.max_word_count_english
            if any(seg.text.lower().startswith(word) for word in prefix_split_words) and len(current_group) >= int(max_word_count * PREFIX_WORD_RATIO):
                result.append(current_group)
                logger.debug("Split before prefix word %s", seg.text)
                current_group = []

            if (
                index > 0
                and any(segments[index - 1].text.lower().endswith(word) for word in suffix_split_words)
                and len(current_group) >= int(max_word_count * SUFFIX_WORD_RATIO)
            ):
                result.append(current_group)
                logger.debug("Split after suffix word %s", segments[index - 1].text)
                current_group = []

            current_group.append(seg)

        if current_group:
            result.append(current_group)
        return result

    def _split_long_segment(self, segments: List[ASRDataSeg]) -> List[ASRDataSeg]:
        result_segs = []
        segments_to_process = [segments]

        while segments_to_process:
            current_segments = segments_to_process.pop(0)
            if not current_segments:
                continue

            merged_text = "".join(seg.text for seg in current_segments).strip()
            max_word_count = self.max_word_count_cjk if is_mainly_cjk(merged_text) else self.max_word_count_english
            count = len(current_segments)

            if count_words(merged_text) <= max_word_count or count < RULE_MIN_SEGMENT_SIZE:
                result_segs.append(
                    ASRDataSeg(
                        merged_text,
                        current_segments[0].start_time,
                        current_segments[-1].end_time,
                    )
                )
                continue

            gaps = [
                current_segments[idx + 1].start_time - current_segments[idx].end_time
                for idx in range(count - 1)
            ]
            all_equal = all(abs(gap - gaps[0]) < 1e-6 for gap in gaps) if gaps else True
            if all_equal:
                split_index = count // 2
            else:
                start_idx = max(count // 6, 1)
                end_idx = min((5 * count) // 6, count - 2)
                split_index = max(
                    range(start_idx, end_idx),
                    key=lambda idx: current_segments[idx + 1].start_time - current_segments[idx].end_time,
                    default=count // 2,
                )
                if split_index in (0, count - 1):
                    split_index = count // 2

            segments_to_process.extend([
                current_segments[:split_index + 1],
                current_segments[split_index + 1:],
            ])

        result_segs.sort(key=lambda seg: seg.start_time)
        return result_segs

    def _merge_processed_segments(self, processed_segments: List[List[ASRDataSeg]]) -> List[ASRDataSeg]:
        final_segments = []
        for segments in processed_segments:
            final_segments.extend(segments)
        final_segments.sort(key=lambda seg: seg.start_time)
        return final_segments

    def merge_short_segment(self, segments: List[ASRDataSeg]) -> None:
        if not segments:
            return

        i = 0
        while i < len(segments) - 1:
            current_seg = segments[i]
            next_seg = segments[i + 1]

            time_gap = abs(next_seg.start_time - current_seg.end_time)
            current_words = count_words(current_seg.text)
            next_words = count_words(next_seg.text)
            total_words = current_words + next_words
            max_word_count = (
                self.max_word_count_cjk
                if is_mainly_cjk(current_seg.text)
                else self.max_word_count_english
            )

            should_merge = (
                time_gap < MERGE_SHORT_GAP
                and (current_words < MERGE_MIN_WORDS or next_words < MERGE_MIN_WORDS)
                and total_words <= max_word_count
            ) or (
                time_gap < MERGE_VERY_SHORT_GAP
                and (
                    current_words < MERGE_VERY_SHORT_WORDS
                    or next_words < MERGE_VERY_SHORT_WORDS
                )
                and total_words <= max_word_count
            )

            if should_merge:
                logger.debug(
                    "Merging short segments: %s + %s (gap: %sms)",
                    current_seg.text,
                    next_seg.text,
                    time_gap,
                )
                if is_mainly_cjk(current_seg.text):
                    current_seg.text += next_seg.text
                else:
                    current_seg.text += " " + next_seg.text
                current_seg.end_time = next_seg.end_time
                segments.pop(i + 1)
            else:
                i += 1

    def _merge_segments_based_on_sentences(self, segments: List[ASRDataSeg], sentences: List[str], max_unmatched: int = MATCH_MAX_UNMATCHED):
        def preprocess_text(value: str) -> str:
            return " ".join(value.lower().split())

        asr_texts = [seg.text for seg in segments]
        asr_len = len(asr_texts)
        asr_index = 0
        threshold = MATCH_SIMILARITY_THRESHOLD
        max_shift = MATCH_MAX_SHIFT
        unmatched_count = 0
        new_segments = []

        for sentence in sentences:
            logger.debug("==========")
            logger.debug("Processing sentence: %s", sentence)
            logger.debug("Next sentences: %s", "".join(asr_texts[asr_index:asr_index + 10]))
            sentence_proc = preprocess_text(sentence)
            word_count = count_words(sentence_proc)
            best_ratio = 0.0
            best_pos = None
            best_window_size = 0

            max_window_size = min(max(1, word_count * 2), asr_len - asr_index)
            min_window_size = max(1, word_count // 2)
            window_sizes = sorted(
                range(min_window_size, max_window_size + 1),
                key=lambda size: abs(size - max(1, word_count)),
            )

            for window_size in window_sizes:
                max_start = min(asr_index + max_shift + 1, asr_len - window_size + 1)
                for start in range(asr_index, max_start):
                    substr = "".join(asr_texts[start:start + window_size])
                    ratio = difflib.SequenceMatcher(None, sentence_proc, preprocess_text(substr)).ratio()
                    if ratio > best_ratio:
                        best_ratio = ratio
                        best_pos = start
                        best_window_size = window_size
                    if ratio == 1.0:
                        break
                if best_ratio == 1.0:
                    break

            if best_ratio >= threshold and best_pos is not None:
                start_seg_index = best_pos
                end_seg_index = best_pos + best_window_size - 1
                segs_to_merge = segments[start_seg_index:end_seg_index + 1]
                seg_groups = self._group_by_time_gaps(segs_to_merge, max_gap=MAX_GAP)
                for group in seg_groups:
                    merged_seg = ASRDataSeg(
                        "".join(seg.text for seg in group),
                        group[0].start_time,
                        group[-1].end_time,
                    )
                    logger.debug("Merged segments: %s", merged_seg.text)
                    new_segments.extend(self._split_long_segment(group))
                max_shift = MATCH_MAX_SHIFT
                asr_index = end_seg_index + 1
            else:
                logger.warning("Cannot match sentence: %s", sentence)
                unmatched_count += 1
                if unmatched_count > max_unmatched:
                    raise ValueError(
                        f"Unmatched sentences exceeded threshold {max_unmatched}, processing aborted"
                    )
                max_shift = MATCH_LARGE_SHIFT
                asr_index = min(asr_index + 1, max(0, asr_len - 1))

        return new_segments

    def stop(self):
        if not self.is_running:
            return
        self.is_running = False
        if self.executor is not None:
            try:
                self.executor.shutdown(wait=False, cancel_futures=True)
            except Exception as error:
                logger.error("Error closing thread pool: %s", error)
            finally:
                self.executor = None


def split_subtitle_segments(
    segments: list[dict],
    splitter_kwargs: dict | None = None,
    thread_num: int = 1,
    max_word_count_cjk: int = MAX_WORD_COUNT_CJK,
    max_word_count_english: int = MAX_WORD_COUNT_ENGLISH,
) -> list[dict]:
    if not segments:
        return []

    asr_segments = []
    for item in segments:
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        asr_segments.append(
            ASRDataSeg(
                text=text,
                start_time=int(round(float(item.get("start", 0.0)) * 1000)),
                end_time=int(round(float(item.get("end", item.get("start", 0.0))) * 1000)),
            )
        )

    if not asr_segments:
        return []

    translator = None
    splitter = None
    try:
        if _should_enable_llm(splitter_kwargs):
            translator = LLMTranslator(**(splitter_kwargs or {}))
        splitter = SubtitleSplitter(
            translator=translator,
            thread_num=thread_num,
            model=(splitter_kwargs or {}).get("model", DEFAULT_SPLIT_MODEL),
            max_word_count_cjk=max_word_count_cjk,
            max_word_count_english=max_word_count_english,
        )
        split_data = splitter.split_subtitle(ASRData(asr_segments))
    except Exception as error:
        logger.warning("VideoCaptioner splitter failed, returning rule-based segmentation: %s", error)
        try:
            fallback_splitter = SubtitleSplitter(
                translator=None,
                thread_num=thread_num,
                model=(splitter_kwargs or {}).get("model", DEFAULT_SPLIT_MODEL),
                max_word_count_cjk=max_word_count_cjk,
                max_word_count_english=max_word_count_english,
            )
            split_data = fallback_splitter.split_subtitle(ASRData(asr_segments))
            fallback_splitter.stop()
        except Exception as fallback_error:
            logger.warning("Rule-based subtitle fallback failed, returning original segments: %s", fallback_error)
            return segments
    finally:
        if splitter is not None:
            splitter.stop()
        if translator is not None:
            translator.cleanup()

    result = []
    for seg in split_data.segments:
        text = seg.text.strip()
        if not text:
            continue
        result.append(
            {
                "start": round(float(seg.start_time) / 1000.0, 3),
                "end": round(float(seg.end_time) / 1000.0, 3),
                "text": text,
            }
        )

    return result or segments
