import logging
import pathlib
import sys
import types
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from bootstrap.execution_services_factory import (
    ExecutionObservabilityDependencies,
    ExecutionRuntimeDependencies,
    ExecutionServiceFactoryContext,
    RuntimeProfileDependencies,
    build_execution_services,
)
from vsm.app.workflows.dub_video_workflow import _run_dub_translation_stage
from vsm.app.workflows.translation_workflow import translate_text_workflow


class _DummyTranslator:
    def __init__(self) -> None:
        self.batch_calls: list[tuple[list[str], str]] = []
        self.single_calls: list[tuple[str, str]] = []
        self.cleanup_calls = 0

    def translate_batch(self, texts, target_lang):
        self.batch_calls.append((list(texts), target_lang))
        return [f"{text}-{target_lang}" for text in texts]

    def translate(self, text, target_lang):
        self.single_calls.append((text, target_lang))
        return f"{text}-{target_lang}"

    def cleanup(self):
        self.cleanup_calls += 1


class _SharedTranslator(_DummyTranslator):
    instance_count = 0

    def __init__(self, **kwargs) -> None:
        super().__init__()
        self.kwargs = kwargs
        type(self).instance_count += 1


class TranslationWorkflowTests(unittest.TestCase):
    def test_translate_text_workflow_uses_sequential_strategy_for_segment_lists(self) -> None:
        translator = _DummyTranslator()
        stage_events: list[tuple[str, str, str, str]] = []
        cleanup_calls: list[_DummyTranslator] = []

        result = translate_text_workflow(
            '[{"text":"hello"},{"text":"world"}]',
            "English",
            translator_factory=lambda **_: translator,
            cleanup_translator=lambda current: cleanup_calls.append(current),
            exception_result=lambda *args, **kwargs: {"success": False, "args": args, "kwargs": kwargs},
            emit_stage=lambda action, stage, message, stage_label=None, **_: stage_events.append(
                (action, stage, message, stage_label or "")
            ),
            emit_progress=lambda *args, **kwargs: None,
            emit_partial_result=lambda *args, **kwargs: None,
        )

        self.assertTrue(result["success"])
        self.assertEqual(
            [{"text": "hello-English"}, {"text": "world-English"}],
            result["segments"],
        )
        self.assertEqual([], translator.batch_calls)
        self.assertEqual([("hello", "English"), ("world", "English")], translator.single_calls)
        self.assertEqual(0, translator.cleanup_calls)
        self.assertEqual([translator], cleanup_calls)
        self.assertEqual("translate_init", stage_events[0][1])

    def test_execution_services_reuses_translator_between_translation_requests(self) -> None:
        fake_llm_module = types.ModuleType("llm")
        fake_llm_module.LLMTranslator = _SharedTranslator
        original_llm_module = sys.modules.get("llm")
        sys.modules["llm"] = fake_llm_module
        _SharedTranslator.instance_count = 0

        try:
            services = build_execution_services(
                ExecutionServiceFactoryContext(
                    runtime=ExecutionRuntimeDependencies(
                        logger=object(),
                        logging_module=object(),
                        ffmpeg_module=object(),
                        setup_gpu_paths=lambda logger: None,
                    ),
                    runtime_profiles=RuntimeProfileDependencies(
                        resolve_tts_runner=lambda *args, **kwargs: None,
                        run_tts_runtime_warmup=lambda *args, **kwargs: None,
                        ensure_transformers_version=lambda version: True,
                        check_gpu_deps=lambda: None,
                        get_installed_version=lambda name: None,
                        infer_runtime_profile=lambda **kwargs: "auto",
                        normalize_runtime_profile=lambda value: value or "auto",
                        resolve_runtime_profile_version=lambda value: None,
                    ),
                    observability=ExecutionObservabilityDependencies(
                        log_business=lambda *args, **kwargs: None,
                        log_error=lambda *args, **kwargs: None,
                        emit_stage=lambda *args, **kwargs: None,
                        emit_error_issue=lambda *args, **kwargs: None,
                        error_result=lambda value: value,
                        make_error=lambda *args, **kwargs: None,
                        exception_result=lambda *args, **kwargs: {"success": False},
                        emit_progress=lambda *args, **kwargs: None,
                        emit_partial_result=lambda *args, **kwargs: None,
                    ),
                )
            )

            first = services.translate_text('[{"text":"one"}]', "French", api_key="k", base_url="u", model="m")
            second = services.translate_text('[{"text":"two"}]', "French", api_key="k", base_url="u", model="m")

            self.assertTrue(first["success"])
            self.assertTrue(second["success"])
            self.assertEqual(1, _SharedTranslator.instance_count)
        finally:
            if original_llm_module is None:
                sys.modules.pop("llm", None)
            else:
                sys.modules["llm"] = original_llm_module

    def test_dub_translation_stage_uses_sequential_translation(self) -> None:
        translator = _DummyTranslator()
        partial_results: list[tuple[str, dict[str, str | int]]] = []
        progress_events: list[tuple[str, str, int, str]] = []

        result = _run_dub_translation_stage(
            translator,
            [{"text": "one"}, {"text": "two"}],
            "German",
            log_business=lambda *args, **kwargs: None,
            logger=object(),
            logging=logging,
            emit_stage=lambda *args, **kwargs: None,
            emit_progress=lambda action, stage, percent, message, **kwargs: progress_events.append(
                (action, stage, percent, message)
            ),
            emit_partial_result=lambda action, payload: partial_results.append((action, payload)),
        )

        self.assertEqual(["one-German", "two-German"], result)
        self.assertEqual([], translator.batch_calls)
        self.assertEqual([("one", "German"), ("two", "German")], translator.single_calls)
        self.assertEqual(
            [
                ("dub_video", {"index": 0, "text": "one-German"}),
                ("dub_video", {"index": 1, "text": "two-German"}),
            ],
            partial_results,
        )
        self.assertEqual(2, len(progress_events))


if __name__ == "__main__":
    unittest.main()
