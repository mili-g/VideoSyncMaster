import pathlib
import sys
import unittest
from unittest.mock import patch


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from package_app import get_env_cache_dir


class PackageAppLayoutTests(unittest.TestCase):
    @patch("package_app.resolve_env_cache_dir", return_value="C:/repo/storage/cache/env")
    def test_get_env_cache_dir_delegates_to_shared_path_layout(self, resolve_env_cache_dir_mock) -> None:
        result = get_env_cache_dir(pathlib.Path("C:/repo"))

        self.assertEqual(pathlib.Path("C:/repo/storage/cache/env"), result)
        resolve_env_cache_dir_mock.assert_called_once_with("C:\\repo")


if __name__ == "__main__":
    unittest.main()
