import os
import pathlib
import sys
import unittest
from unittest import mock


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from bootstrap.runtime_env import configure_models_environment, resolve_models_hub_dir


class RuntimeEnvModelsRootTests(unittest.TestCase):
    def test_resolve_models_hub_dir_normalizes_worker_model_dir_argument(self) -> None:
        resolved = resolve_models_hub_dir(
            app_root="C:/repo",
            current_dir="C:/repo/services/media_pipeline",
            argv=["main.py", "--worker", "--model_dir", "D:/shared/models/index-tts/hub"],
            debug_print=lambda _message: None,
        )
        self.assertEqual("D:/shared/models", resolved.replace("\\", "/"))

    def test_resolve_models_hub_dir_prefers_override_from_get_models_root(self) -> None:
        with mock.patch("bootstrap.runtime_env.get_models_root", return_value="D:/shared/models"), \
             mock.patch("bootstrap.runtime_env.os.path.exists", side_effect=lambda path: path == "D:/shared/models"), \
             mock.patch("bootstrap.runtime_env.os.path.isdir", side_effect=lambda path: path == "D:/shared/models"), \
             mock.patch("bootstrap.runtime_env.os.listdir", return_value=["index-tts"]):
            resolved = resolve_models_hub_dir(
                app_root="C:/repo",
                current_dir="C:/repo/services/media_pipeline",
                argv=["main.py"],
                debug_print=lambda _message: None,
            )
        self.assertEqual("D:/shared/models", resolved.replace("\\", "/"))

    def test_configure_models_environment_sets_root_variables(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False):
            configure_models_environment("D:/shared/models/index-tts/hub")
            self.assertEqual("D:/shared/models", os.environ["HF_HOME"].replace("\\", "/"))
            self.assertEqual("D:/shared/models", os.environ["HF_HUB_CACHE"].replace("\\", "/"))
            self.assertEqual("D:/shared/models", os.environ["VSM_MODELS_ROOT"].replace("\\", "/"))


if __name__ == "__main__":
    unittest.main()
