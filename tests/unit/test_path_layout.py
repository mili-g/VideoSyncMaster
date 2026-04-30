import pathlib
import os
import sys
import unittest
from unittest.mock import patch


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from bootstrap.path_layout import get_media_tool_root, get_project_root, resolve_env_cache_dir


class PathLayoutTests(unittest.TestCase):
    def test_get_project_root_accepts_current_structure_markers(self) -> None:
        current_dir = "C:/repo/services/media_pipeline"

        def fake_exists(path: str) -> bool:
            normalized = path.replace("\\", "/")
            existing = {
                "C:/repo/package.json",
                "C:/repo/requirements.txt",
                "C:/repo/services",
            }
            return normalized in existing

        with patch("bootstrap.path_layout.os.path.exists", side_effect=fake_exists):
            self.assertEqual(os.path.normpath("C:/repo"), get_project_root(current_dir))

    def test_get_project_root_falls_back_to_legacy_structure_markers(self) -> None:
        current_dir = "C:/repo/backend"

        def fake_exists(path: str) -> bool:
            normalized = path.replace("\\", "/")
            existing = {
                "C:/repo/package.json",
                "C:/repo/requirements.txt",
                "C:/repo/backend",
            }
            return normalized in existing

        with patch("bootstrap.path_layout.os.path.exists", side_effect=fake_exists):
            self.assertEqual(os.path.normpath("C:/repo"), get_project_root(current_dir))

    def test_get_media_tool_root_prefers_resources_layout_over_legacy_backend_layout(self) -> None:
        project_root = "C:/repo"

        def fake_exists(path: str) -> bool:
            normalized = path.replace("\\", "/")
            existing = {
                "C:/repo/resources/media_tools/ffmpeg",
                "C:/repo/backend/ffmpeg",
            }
            return normalized in existing

        with patch("bootstrap.path_layout.os.path.exists", side_effect=fake_exists):
            self.assertEqual(
                "C:/repo/resources/media_tools/ffmpeg",
                get_media_tool_root(project_root, "ffmpeg").replace("\\", "/"),
            )

    def test_resolve_env_cache_dir_prefers_storage_cache(self) -> None:
        project_root = "C:/repo"

        def fake_isdir(path: str) -> bool:
            normalized = path.replace("\\", "/")
            return normalized in {"C:/repo/storage", "C:/repo/storage/cache/env"}

        with patch("bootstrap.path_layout.os.path.isdir", side_effect=fake_isdir):
            self.assertEqual(
                "C:/repo/storage/cache/env",
                resolve_env_cache_dir(project_root).replace("\\", "/"),
            )

    def test_resolve_env_cache_dir_falls_back_to_legacy_cache(self) -> None:
        project_root = "C:/repo"

        def fake_isdir(path: str) -> bool:
            return path.replace("\\", "/") == "C:/repo/.env_cache"

        with patch("bootstrap.path_layout.os.path.isdir", side_effect=fake_isdir):
            self.assertEqual(
                "C:/repo/.env_cache",
                resolve_env_cache_dir(project_root).replace("\\", "/"),
            )


if __name__ == "__main__":
    unittest.main()
