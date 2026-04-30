import pathlib
import sys
import types
import unittest
from unittest.mock import Mock, patch


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from bootstrap.startup_context import initialize_runtime_bootstrap


class StartupContextTests(unittest.TestCase):
    @patch("bootstrap.startup_context.os.path.exists", return_value=True)
    @patch("bootstrap.startup_context.setup_gpu_paths")
    @patch("bootstrap.startup_context.ensure_portable_ffmpeg", return_value="C:/ffmpeg/bin")
    @patch("bootstrap.startup_context.configure_models_environment")
    @patch("bootstrap.startup_context.resolve_models_hub_dir", return_value="C:/models")
    @patch("bootstrap.startup_context.enable_stream_tee")
    @patch("bootstrap.startup_context.enforce_portable_python")
    @patch("bootstrap.startup_context.install_exception_hook")
    @patch("bootstrap.startup_context.initialize_debug_log", return_value=("C:/logs/backend_debug.log", lambda message: None))
    @patch("bootstrap.startup_context.resolve_runtime_context", return_value=("C:/svc", "C:/app", False))
    @patch("bootstrap.startup_context.redirect_print", return_value=lambda *args, **kwargs: None)
    @patch("bootstrap.startup_context.get_logger", return_value="logger")
    @patch("bootstrap.startup_context.patch_subprocess_encoding")
    @patch("bootstrap.startup_context.apply_base_environment")
    @patch("bootstrap.startup_context.configure_stdio_utf8")
    def test_initialize_runtime_bootstrap_returns_composed_context(
        self,
        configure_stdio_utf8_mock,
        apply_base_environment_mock,
        patch_subprocess_encoding_mock,
        get_logger_mock,
        redirect_print_mock,
        resolve_runtime_context_mock,
        initialize_debug_log_mock,
        install_exception_hook_mock,
        enforce_portable_python_mock,
        enable_stream_tee_mock,
        resolve_models_hub_dir_mock,
        configure_models_environment_mock,
        ensure_portable_ffmpeg_mock,
        setup_gpu_paths_mock,
        exists_mock,
    ) -> None:
        logger = Mock()
        fake_ffmpeg_module = types.SimpleNamespace(name="ffmpeg")
        original_module = sys.modules.get("ffmpeg")
        sys.modules["ffmpeg"] = fake_ffmpeg_module
        get_logger_mock.return_value = logger
        try:
            context = initialize_runtime_bootstrap("C:/app/main.py", ["main.py"])
        finally:
            if original_module is None:
                del sys.modules["ffmpeg"]
            else:
                sys.modules["ffmpeg"] = original_module

        self.assertIs(logger, context.logger)
        self.assertEqual("C:/app", context.app_root)
        self.assertEqual("C:/models", context.models_hub_dir)
        self.assertEqual("C:/ffmpeg/bin", context.ffmpeg_bin)
        self.assertIs(fake_ffmpeg_module, context.ffmpeg_module)
        configure_models_environment_mock.assert_called_once_with("C:/models")
        setup_gpu_paths_mock.assert_called_once_with(logger)
        enable_stream_tee_mock.assert_called_once_with("C:/logs/backend_debug.log")

    @patch("bootstrap.startup_context.log_business")
    @patch("bootstrap.startup_context.log_error")
    @patch("bootstrap.startup_context.os.path.exists", return_value=False)
    @patch("bootstrap.startup_context.setup_gpu_paths")
    @patch("bootstrap.startup_context.ensure_portable_ffmpeg", return_value="C:/ffmpeg/bin")
    @patch("bootstrap.startup_context.configure_models_environment")
    @patch("bootstrap.startup_context.resolve_models_hub_dir", return_value="C:/missing-models")
    @patch("bootstrap.startup_context.enable_stream_tee")
    @patch("bootstrap.startup_context.enforce_portable_python")
    @patch("bootstrap.startup_context.install_exception_hook")
    @patch("bootstrap.startup_context.initialize_debug_log", return_value=("C:/logs/backend_debug.log", lambda message: None))
    @patch("bootstrap.startup_context.resolve_runtime_context", return_value=("C:/svc", "C:/app", False))
    @patch("bootstrap.startup_context.redirect_print", return_value=lambda *args, **kwargs: None)
    @patch("bootstrap.startup_context.get_logger", return_value="logger")
    @patch("bootstrap.startup_context.patch_subprocess_encoding")
    @patch("bootstrap.startup_context.apply_base_environment")
    @patch("bootstrap.startup_context.configure_stdio_utf8")
    def test_initialize_runtime_bootstrap_logs_missing_model_dir(
        self,
        configure_stdio_utf8_mock,
        apply_base_environment_mock,
        patch_subprocess_encoding_mock,
        get_logger_mock,
        redirect_print_mock,
        resolve_runtime_context_mock,
        initialize_debug_log_mock,
        install_exception_hook_mock,
        enforce_portable_python_mock,
        enable_stream_tee_mock,
        resolve_models_hub_dir_mock,
        configure_models_environment_mock,
        ensure_portable_ffmpeg_mock,
        setup_gpu_paths_mock,
        exists_mock,
        log_error_mock,
        log_business_mock,
    ) -> None:
        fake_ffmpeg_module = types.SimpleNamespace(name="ffmpeg")
        original_module = sys.modules.get("ffmpeg")
        sys.modules["ffmpeg"] = fake_ffmpeg_module
        try:
            initialize_runtime_bootstrap("C:/app/main.py", ["main.py"])
        finally:
            if original_module is None:
                del sys.modules["ffmpeg"]
            else:
                sys.modules["ffmpeg"] = original_module

        log_error_mock.assert_called_once()
        self.assertTrue(any(call.kwargs.get("event") == "model_dir_missing" for call in log_business_mock.call_args_list))


if __name__ == "__main__":
    unittest.main()
