import pathlib
import sys
import unittest
from unittest.mock import patch


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from bootstrap.dependency_runtime import get_env_cache_dir


class DependencyRuntimeTests(unittest.TestCase):
    @patch("bootstrap.dependency_runtime.resolve_env_cache_dir", return_value="C:/repo/storage/cache/env")
    @patch("bootstrap.dependency_runtime.get_project_root", return_value="C:/repo")
    def test_get_env_cache_dir_delegates_to_path_layout_strategy(
        self,
        get_project_root_mock,
        resolve_env_cache_dir_mock,
    ) -> None:
        cache_dir = get_env_cache_dir("C:/repo/services/media_pipeline/bootstrap/dependency_runtime.py")

        self.assertEqual("C:/repo/storage/cache/env", cache_dir)
        get_project_root_mock.assert_called_once()
        resolve_env_cache_dir_mock.assert_called_once_with("C:/repo")


if __name__ == "__main__":
    unittest.main()
