import atexit
import difflib
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Tuple

try:
    import json_repair
except ImportError:
    json_repair = None

from app_logging import get_logger, redirect_print
from asr_data import ASRData, ASRDataSeg
from llm import LLMTranslator
from subtitle_alignment import SubtitleAligner
from text_utils import count_words

logger = get_logger("subtitle.optimizer")
print = redirect_print(logger, default_level=logging.DEBUG)

DEFAULT_BATCH_SIZE = 10
DEFAULT_THREAD_NUM = 1
MAX_OPTIMIZE_STEPS = 3

OPTIMIZE_SYSTEM_PROMPT = """You are a professional subtitle correction expert.

Fix subtitle recognition errors while preserving the original meaning, tone, and sentence structure.

Rules:
1. Keep the original language. Never translate.
2. Keep the original numbering. Do not add, drop, merge, or reorder keys.
3. Make minimal edits only for ASR cleanup:
   - fix misrecognized words
   - fix broken words, mixed-language tokens, product names, abbreviations, and version strings
   - remove obvious filler sounds and non-speech markers
   - normalize punctuation and capitalization when needed
4. Do not rewrite style or expand content.
5. Output only a valid JSON object.
"""


def _parse_json_object(payload: str) -> Dict[str, str]:
    text = (payload or "").strip()
    if not text:
        raise ValueError("LLM returned empty content.")

    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)

    if json_repair is not None:
        parsed = json_repair.loads(text)
    else:
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        parsed = json.loads(match.group(0) if match else text)

    if not isinstance(parsed, dict):
        raise ValueError(f"Expected JSON object, got {type(parsed)}.")

    return {str(key): str(value).strip() for key, value in parsed.items()}


class SubtitleOptimizer:
    def __init__(
        self,
        translator: LLMTranslator,
        *,
        batch_size: int = DEFAULT_BATCH_SIZE,
        thread_num: int = DEFAULT_THREAD_NUM,
        custom_prompt: str = "",
    ):
        self.translator = translator
        self.batch_size = max(1, int(batch_size))
        self.thread_num = max(1, int(thread_num))
        self.custom_prompt = custom_prompt.strip()
        self.is_running = True
        self.executor = ThreadPoolExecutor(max_workers=self.thread_num)
        atexit.register(self.stop)

    def stop(self):
        if not self.is_running:
            return
        self.is_running = False
        if self.executor is not None:
            try:
                self.executor.shutdown(wait=False, cancel_futures=True)
            except Exception:
                pass
            finally:
                self.executor = None

    def optimize_subtitle(self, subtitle_data: ASRData) -> ASRData:
        subtitle_dict = {
            str(index): seg.text for index, seg in enumerate(subtitle_data.segments, start=1)
        }
        chunks = self._split_chunks(subtitle_dict)
        optimized_dict = self._parallel_optimize(chunks)
        segments = self._create_segments(subtitle_data.segments, optimized_dict)
        return ASRData(segments)

    def _split_chunks(self, subtitle_dict: Dict[str, str]) -> List[Dict[str, str]]:
        items = list(subtitle_dict.items())
        return [
            dict(items[index:index + self.batch_size])
            for index in range(0, len(items), self.batch_size)
        ]

    def _parallel_optimize(self, chunks: List[Dict[str, str]]) -> Dict[str, str]:
        if not chunks:
            return {}
        if self.executor is None:
            raise RuntimeError("Thread pool is not available.")

        futures = []
        optimized_dict: Dict[str, str] = {}
        for chunk in chunks:
            futures.append((self.executor.submit(self._optimize_chunk, chunk), chunk))

        for future, original_chunk in futures:
            try:
                optimized_dict.update(future.result())
            except Exception as error:
                logger.warning("Subtitle optimize chunk failed: %s", error)
                optimized_dict.update(original_chunk)
        return optimized_dict

    def _optimize_chunk(self, subtitle_chunk: Dict[str, str]) -> Dict[str, str]:
        messages = [
            {"role": "system", "content": OPTIMIZE_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": self._build_user_prompt(subtitle_chunk),
            },
        ]
        last_result = subtitle_chunk

        for _ in range(MAX_OPTIMIZE_STEPS):
            response_text = self.translator.chat_complete(
                messages,
                temperature=0.2,
                max_new_tokens=2048,
            )
            parsed_result = _parse_json_object(response_text)
            last_result = parsed_result

            is_valid, error_message = self._validate_optimization_result(
                original_chunk=subtitle_chunk,
                optimized_chunk=parsed_result,
            )
            if is_valid:
                return self._repair_subtitle(subtitle_chunk, parsed_result)

            messages.append({"role": "assistant", "content": response_text})
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Validation failed: "
                        + error_message
                        + "\nReturn the complete corrected JSON object only."
                    ),
                }
            )

        return self._repair_subtitle(subtitle_chunk, last_result)

    def _build_user_prompt(self, subtitle_chunk: Dict[str, str]) -> str:
        prompt = (
            "Correct the following subtitles without translating them.\n"
            "Pay special attention to broken English words, mixed Chinese-English tokens, "
            "product names, abbreviations, and version strings.\n"
            "<input_subtitle>\n"
            f"{json.dumps(subtitle_chunk, ensure_ascii=False)}\n"
            "</input_subtitle>"
        )
        if self.custom_prompt:
            prompt += f"\n<reference>\n{self.custom_prompt}\n</reference>"
        return prompt

    def _validate_optimization_result(
        self,
        *,
        original_chunk: Dict[str, str],
        optimized_chunk: Dict[str, str],
    ) -> Tuple[bool, str]:
        expected_keys = set(original_chunk.keys())
        actual_keys = set(optimized_chunk.keys())
        if expected_keys != actual_keys:
            missing = sorted(expected_keys - actual_keys)
            extra = sorted(actual_keys - expected_keys)
            return False, f"Keys mismatch. Missing={missing}, Extra={extra}."

        for key in expected_keys:
            original_text = re.sub(r"\s+", " ", original_chunk[key]).strip()
            optimized_text = re.sub(r"\s+", " ", optimized_chunk[key]).strip()
            matcher = difflib.SequenceMatcher(None, original_text, optimized_text)
            similarity = matcher.ratio()
            similarity_threshold = 0.3 if count_words(original_text) <= 10 else 0.7
            if similarity < similarity_threshold:
                return (
                    False,
                    f"Key {key} changed too much ({similarity:.1%} < {similarity_threshold:.0%}). "
                    f"Original='{original_chunk[key]}' Optimized='{optimized_chunk[key]}'.",
                )

        return True, ""

    def _repair_subtitle(
        self,
        original_chunk: Dict[str, str],
        optimized_chunk: Dict[str, str],
    ) -> Dict[str, str]:
        try:
            aligner = SubtitleAligner()
            original_list = list(original_chunk.values())
            optimized_list = list(optimized_chunk.values())
            _, aligned_target = aligner.align_texts(original_list, optimized_list)
            if len(aligned_target) != len(original_list):
                return optimized_chunk
            start_id = int(next(iter(original_chunk.keys())))
            return {
                str(start_id + index): (text.strip() or original_list[index])
                for index, text in enumerate(aligned_target)
            }
        except Exception as error:
            logger.warning("Subtitle alignment repair failed: %s", error)
            return optimized_chunk

    @staticmethod
    def _create_segments(
        original_segments: List[ASRDataSeg],
        optimized_dict: Dict[str, str],
    ) -> List[ASRDataSeg]:
        result = []
        for index, segment in enumerate(original_segments, start=1):
            result.append(
                ASRDataSeg(
                    text=optimized_dict.get(str(index), segment.text),
                    start_time=segment.start_time,
                    end_time=segment.end_time,
                    translated_text=segment.translated_text,
                )
            )
        return result


def optimize_subtitle_segments(
    segments: List[dict],
    optimizer_kwargs: dict | None = None,
) -> List[dict]:
    if not segments:
        return []

    optimizer_kwargs = optimizer_kwargs or {}
    translator = None
    optimizer = None
    try:
        translator_kwargs = dict(optimizer_kwargs)
        has_external_api = bool(str(translator_kwargs.get("api_key") or "").strip())
        allow_local_llm = translator_kwargs.get("enable_local_llm") in (True, "true", "1", 1)
        batch_size = int(translator_kwargs.pop("batch_size", DEFAULT_BATCH_SIZE) or DEFAULT_BATCH_SIZE)
        thread_num = int(translator_kwargs.pop("thread_num", DEFAULT_THREAD_NUM) or DEFAULT_THREAD_NUM)
        custom_prompt = str(translator_kwargs.pop("custom_prompt", "") or "")

        if not has_external_api and not allow_local_llm:
            logger.debug("Subtitle optimizer skipped because no translation API or explicit local LLM opt-in was provided.")
            return segments

        translator = LLMTranslator(**translator_kwargs)
        if not translator.use_external and translator.model is None:
            logger.warning("Subtitle optimizer skipped because local LLM is unavailable.")
            return segments

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
            return segments

        optimizer = SubtitleOptimizer(
            translator,
            batch_size=batch_size,
            thread_num=thread_num,
            custom_prompt=custom_prompt,
        )
        optimized = optimizer.optimize_subtitle(ASRData(asr_segments))
        optimized.remove_punctuation()
        return [
            {
                "start": round(float(seg.start_time) / 1000.0, 3),
                "end": round(float(seg.end_time) / 1000.0, 3),
                "text": seg.text.strip(),
            }
            for seg in optimized.segments
            if seg.text.strip()
        ] or segments
    except Exception as error:
        logger.warning("Subtitle optimize failed, returning original segments: %s", error)
        return segments
    finally:
        if optimizer is not None:
            optimizer.stop()
        if translator is not None:
            translator.cleanup()
