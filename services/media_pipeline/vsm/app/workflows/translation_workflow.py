from __future__ import annotations

import json
from typing import Any, Protocol


class TranslationStrategy(Protocol):
    def translate(self, payload: list[dict[str, Any]] | str, target_lang: str) -> dict[str, Any]:
        ...


class SequentialTranslationStrategy:
    def __init__(self, translator, *, emit_stage, emit_progress, emit_partial_result) -> None:
        self._translator = translator
        self._emit_stage = emit_stage
        self._emit_progress = emit_progress
        self._emit_partial_result = emit_partial_result

    def translate(self, payload: list[dict[str, Any]] | str, target_lang: str) -> dict[str, Any]:
        if isinstance(payload, str):
            text = self._translator.translate(payload, target_lang)
            _ensure_text(text, "Translation failed: empty translated text")
            return {"success": True, "text": text}

        action_name = "translate_text"
        print(f"Translating {len(payload)} segments to {target_lang}...")
        self._emit_stage(
            action_name,
            "translate",
            f"正在翻译 {len(payload)} 个片段到 {target_lang}",
            stage_label="正在翻译字幕",
        )

        translated_segments = []
        for index, item in enumerate(payload):
            original = item.get("text", "")
            if not original:
                translated_segments.append(item)
                continue

            print(f"  [{index + 1}/{len(payload)}] {original}")
            self._emit_progress(
                action_name,
                "translate",
                int((index + 1) / len(payload) * 100),
                f"第 {index + 1}/{len(payload)} 条翻译中",
                stage_label="正在翻译字幕",
                item_index=index + 1,
                item_total=len(payload),
            )
            translated_text = self._translator.translate(original, target_lang)
            _ensure_text(translated_text, f"Translation failed for segment {index + 1}: empty translated text")

            self._emit_partial_result(action_name, {"index": index, "text": translated_text})
            new_item = item.copy()
            new_item["text"] = translated_text
            translated_segments.append(new_item)

        return {"success": True, "segments": translated_segments}


def _ensure_text(value: Any, message: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(message)


def translate_text_workflow(
    input_text_or_json,
    target_lang,
    *,
    translator_factory,
    cleanup_translator=None,
    exception_result,
    emit_stage,
    emit_progress,
    emit_partial_result,
    **translator_kwargs,
):
    action_name = "translate_text"
    emit_stage(
        action_name,
        "translate_init",
        f"正在初始化翻译器并准备翻译到 {target_lang}",
        stage_label="正在准备翻译",
    )
    translator = translator_factory(**translator_kwargs)
    try:
        try:
            payload = json.loads(input_text_or_json)
        except json.JSONDecodeError:
            payload = input_text_or_json

        strategy = SequentialTranslationStrategy(
            translator,
            emit_stage=emit_stage,
            emit_progress=emit_progress,
            emit_partial_result=emit_partial_result,
        )
        return strategy.translate(payload, target_lang)
    except Exception as error:
        return exception_result(
            "TRANSLATE_FAILED",
            "翻译失败",
            error,
            category="translation",
            stage="translate",
            retryable=True,
        )
    finally:
        if callable(cleanup_translator):
            cleanup_translator(translator)
        else:
            translator.cleanup()
