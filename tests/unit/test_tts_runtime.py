import pathlib
import sys
import unittest
from unittest.mock import patch


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from bootstrap import tts_runtime


class _FakeTimer:
    def __init__(self, delay, callback):
        self.delay = delay
        self.callback = callback
        self.daemon = False
        self.started = False
        self.cancelled = False

    def start(self):
        self.started = True

    def cancel(self):
        self.cancelled = True


class TtsRuntimeTests(unittest.TestCase):
    def tearDown(self) -> None:
        tts_runtime._run_tts = None
        tts_runtime._run_batch_tts = None
        tts_runtime._loaded_tts_service = None
        tts_runtime._gpt_sovits_idle_timer = None

    def test_cleanup_loaded_tts_runtime_schedules_idle_cleanup_for_gpt_sovits(self) -> None:
        created: list[_FakeTimer] = []

        def fake_timer(delay, callback):
            timer = _FakeTimer(delay, callback)
            created.append(timer)
            return timer

        tts_runtime._loaded_tts_service = "gptsovits"
        tts_runtime._run_tts = object()
        tts_runtime._run_batch_tts = object()

        with patch.object(tts_runtime.threading, "Timer", side_effect=fake_timer):
            tts_runtime.cleanup_loaded_tts_runtime()

        self.assertEqual(1, len(created))
        self.assertTrue(created[0].started)
        self.assertEqual("gptsovits", tts_runtime._loaded_tts_service)

    def test_cleanup_loaded_tts_runtime_cleans_non_gpt_sovits_immediately(self) -> None:
        cleaned: list[str] = []
        tts_runtime._loaded_tts_service = "qwen"
        tts_runtime._run_tts = object()
        tts_runtime._run_batch_tts = object()

        with patch.object(tts_runtime, "_cleanup_tts_service_runtime", side_effect=lambda service: cleaned.append(service)):
            tts_runtime.cleanup_loaded_tts_runtime()

        self.assertEqual(["qwen"], cleaned)
        self.assertIsNone(tts_runtime._loaded_tts_service)
        self.assertIsNone(tts_runtime._run_tts)
        self.assertIsNone(tts_runtime._run_batch_tts)


if __name__ == "__main__":
    unittest.main()
