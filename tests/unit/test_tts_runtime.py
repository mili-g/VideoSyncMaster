import pathlib
import sys
import types
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import bootstrap.tts_runtime as tts_runtime


class TtsRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_qwen_module = sys.modules.get("qwen_tts_service")
        self.original_indextts_module = sys.modules.get("tts")
        tts_runtime._run_tts = None
        tts_runtime._run_batch_tts = None
        tts_runtime._loaded_tts_service = None

    def tearDown(self) -> None:
        if self.original_qwen_module is None:
            sys.modules.pop("qwen_tts_service", None)
        else:
            sys.modules["qwen_tts_service"] = self.original_qwen_module

        if self.original_indextts_module is None:
            sys.modules.pop("tts", None)
        else:
            sys.modules["tts"] = self.original_indextts_module

        tts_runtime._run_tts = None
        tts_runtime._run_batch_tts = None
        tts_runtime._loaded_tts_service = None

    def test_switching_tts_service_cleans_previous_runtime(self) -> None:
        cleanup_calls: list[str] = []

        qwen_module = types.ModuleType("qwen_tts_service")
        qwen_module.get_qwen_tts_runtime_status = lambda: (True, None)
        qwen_module.run_qwen_tts = lambda *args, **kwargs: True
        qwen_module.run_batch_qwen_tts = lambda *args, **kwargs: []
        qwen_module.cleanup_qwen_tts_models = lambda: cleanup_calls.append("qwen")
        sys.modules["qwen_tts_service"] = qwen_module

        indextts_module = types.ModuleType("tts")
        indextts_module.get_indextts_runtime_status = lambda: (True, None)
        indextts_module.run_tts = lambda *args, **kwargs: True
        indextts_module.run_batch_tts = lambda *args, **kwargs: []
        indextts_module.cleanup_indextts_runtime = lambda: cleanup_calls.append("indextts")
        sys.modules["tts"] = indextts_module

        common_kwargs = dict(
            check_deps=False,
            logger=object(),
            setup_gpu_paths=lambda logger: None,
            ensure_transformers_version=lambda version: True,
            check_gpu_deps=lambda: None,
            log_business=lambda *args, **kwargs: None,
            log_error=lambda *args, **kwargs: None,
        )

        qwen_runner = tts_runtime.get_tts_runner("qwen", **common_kwargs)
        indextts_runner = tts_runtime.get_tts_runner("indextts", **common_kwargs)

        self.assertTrue(callable(qwen_runner[0]))
        self.assertTrue(callable(indextts_runner[0]))
        self.assertEqual(["qwen"], cleanup_calls)


if __name__ == "__main__":
    unittest.main()
