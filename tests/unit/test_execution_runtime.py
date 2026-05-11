import pathlib
import sys
import types
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from vsm.app.workflows.execution_runtime import execute_action


class ExecutionRuntimeTests(unittest.TestCase):
    def test_execute_action_always_cleans_loaded_tts_runtime(self) -> None:
        calls: list[str] = []

        args = types.SimpleNamespace(action="generate_batch_tts")

        result = execute_action(
            args,
            build_asr_runtime_config=lambda _args: types.SimpleNamespace(to_runner_kwargs=lambda: {}),
            build_tts_kwargs=lambda _args: {},
            build_translation_kwargs=lambda _args: {},
            services=object(),
            error_result=lambda error: {"error": error},
            make_error=lambda *args, **kwargs: {"args": args, "kwargs": kwargs},
            set_event_context=lambda **kwargs: calls.append(f"set:{kwargs.get('action')}"),
            clear_event_context=lambda: calls.append("clear"),
            build_action_router=lambda **kwargs: types.SimpleNamespace(dispatch=lambda _ctx: {"success": True}),
            log_error=lambda *args, **kwargs: calls.append("log_error"),
            logger=object(),
            cleanup_loaded_tts_runtime=lambda: calls.append("cleanup"),
        )

        self.assertEqual({"success": True}, result)
        self.assertIn("cleanup", calls)
        self.assertEqual("clear", calls[-1])

    def test_execute_action_still_calls_cleanup_for_gpt_sovits_keepalive_path(self) -> None:
        calls: list[str] = []
        args = types.SimpleNamespace(action="generate_batch_tts")

        result = execute_action(
            args,
            build_asr_runtime_config=lambda _args: types.SimpleNamespace(to_runner_kwargs=lambda: {}),
            build_tts_kwargs=lambda _args: {"tts_service": "gptsovits"},
            build_translation_kwargs=lambda _args: {},
            services=object(),
            error_result=lambda error: {"error": error},
            make_error=lambda *args, **kwargs: {"args": args, "kwargs": kwargs},
            set_event_context=lambda **kwargs: calls.append(f"set:{kwargs.get('action')}"),
            clear_event_context=lambda: calls.append("clear"),
            build_action_router=lambda **kwargs: types.SimpleNamespace(dispatch=lambda _ctx: {"success": True}),
            log_error=lambda *args, **kwargs: calls.append("log_error"),
            logger=object(),
            cleanup_loaded_tts_runtime=lambda: calls.append("cleanup"),
        )

        self.assertEqual({"success": True}, result)
        self.assertEqual("cleanup", calls[-2])
        self.assertEqual("clear", calls[-1])


if __name__ == "__main__":
    unittest.main()
