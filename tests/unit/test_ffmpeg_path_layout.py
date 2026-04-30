import pathlib
import sys
import unittest
from unittest.mock import patch


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from infra.ffmpeg import get_ffmpeg_bin_dir


class FfmpegPathLayoutTests(unittest.TestCase):
    def test_get_ffmpeg_bin_dir_falls_back_to_faster_whisper_bundle(self) -> None:
        fake_backend_root = "C:/repo/services/media_pipeline/infra"
        existing_paths = {
            "C:/repo/package.json",
            "C:/repo/requirements.txt",
            "C:/repo/apps",
            "C:/repo/resources/media_tools/faster_whisper/Faster-Whisper-XXL/ffmpeg.exe",
        }

        def fake_exists(path: str) -> bool:
            return path.replace("\\", "/") in existing_paths

        with patch("infra.ffmpeg._backend_root", return_value=fake_backend_root):
            with patch("bootstrap.path_layout.os.path.exists", side_effect=fake_exists):
                with patch("infra.ffmpeg.os.path.exists", side_effect=fake_exists):
                    resolved = get_ffmpeg_bin_dir().replace("\\", "/")
        self.assertEqual("C:/repo/resources/media_tools/faster_whisper/Faster-Whisper-XXL", resolved)


if __name__ == "__main__":
    unittest.main()
