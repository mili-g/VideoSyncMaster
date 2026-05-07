import os
import pathlib
import sys
import unittest
from unittest import mock


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from bootstrap.path_layout import get_runtime_overlay_dir, get_runtime_python_dir, get_runtime_root


class RuntimeRootPathTests(unittest.TestCase):
    def test_get_runtime_root_prefers_environment_override(self) -> None:
        with mock.patch.dict(os.environ, {"VSM_RUNTIME_ROOT": "D:/shared/runtime"}, clear=False):
            self.assertEqual("D:/shared/runtime", get_runtime_root("C:/repo").replace("\\", "/"))

    def test_get_runtime_python_dir_prefers_override(self) -> None:
        target = "D:/shared/runtime/python"
        with mock.patch.dict(os.environ, {"VSM_RUNTIME_ROOT": "D:/shared/runtime"}, clear=False), \
             mock.patch("bootstrap.path_layout.os.path.isdir", side_effect=lambda path: path.replace("\\", "/") == target), \
             mock.patch("bootstrap.path_layout.os.path.exists", side_effect=lambda path: path.replace("\\", "/") == target):
            self.assertEqual(target, get_runtime_python_dir("C:/repo").replace("\\", "/"))

    def test_get_runtime_overlay_dir_prefers_override(self) -> None:
        target = "D:/shared/runtime/overlays/transformers5_asr"
        with mock.patch.dict(os.environ, {"VSM_RUNTIME_ROOT": "D:/shared/runtime"}, clear=False), \
             mock.patch("bootstrap.path_layout.os.path.exists", side_effect=lambda path: path.replace("\\", "/") == target):
            self.assertEqual(target, get_runtime_overlay_dir("C:/repo", "transformers5_asr").replace("\\", "/"))


if __name__ == "__main__":
    unittest.main()
