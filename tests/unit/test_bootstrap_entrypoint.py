import pathlib
import sys
import types
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from bootstrap.entrypoint import (
    BackendExecutionContext,
    WorkerLoopContext,
    extract_worker_base_args,
    run_backend_entrypoint,
)


class BootstrapEntrypointTests(unittest.TestCase):
    def test_extract_worker_base_args_reads_model_dir_pair(self) -> None:
        argv = ["main.py", "--worker", "--model_dir", "C:/models", "--action", "test_asr"]
        self.assertEqual(["--model_dir", "C:/models"], extract_worker_base_args(argv))

    def test_extract_worker_base_args_ignores_missing_model_dir_value(self) -> None:
        argv = ["main.py", "--worker", "--model_dir"]
        self.assertEqual([], extract_worker_base_args(argv))

    def test_run_backend_entrypoint_uses_worker_mode_without_finalizer(self) -> None:
        calls: list[str] = []

        backend_context = BackendExecutionContext(
            execute_with_args=lambda args: calls.append("execute"),
            build_parser=lambda: types.SimpleNamespace(parse_args=lambda: types.SimpleNamespace(action="test_asr", json=False)),
            scoped_event_context=lambda **kwargs: _NoopContextManager(),
            emit_json_block=lambda result, stdout_print: calls.append("emit_json"),
            stdout_print=lambda *args, **kwargs: None,
            setup_gpu_paths=lambda logger: calls.append("setup_gpu"),
            logger=object(),
        )
        worker_context = WorkerLoopContext(run_worker_loop=lambda base_args: calls.append(f"worker:{base_args}"))

        run_backend_entrypoint(
            argv=["main.py", "--worker", "--model_dir", "C:/models"],
            backend_context=backend_context,
            worker_context=worker_context,
            debug_log=lambda message: calls.append(message),
            handle_unhandled_exception=lambda error: calls.append(f"error:{error}"),
            exit_process=lambda code: calls.append(f"exit:{code}"),
            finalize_non_worker_process=lambda: calls.append("finalize"),
        )

        self.assertIn("Entering main block", calls)
        self.assertIn("Main finished normally", calls)
        self.assertIn("worker:['--model_dir', 'C:/models']", calls)
        self.assertNotIn("finalize", calls)
        self.assertNotIn("setup_gpu", calls)


class _NoopContextManager:
    def __enter__(self):
        return None

    def __exit__(self, exc_type, exc, tb):
        return False


if __name__ == "__main__":
    unittest.main()
