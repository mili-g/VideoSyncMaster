import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest import mock


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import alignment


class AlignmentRifeTests(unittest.TestCase):
    def test_get_rife_executable_returns_absolute_model_path(self) -> None:
        with mock.patch("alignment.get_project_root", return_value="C:/repo"), \
             mock.patch("alignment.get_models_root", return_value="D:/assets/models"), \
             mock.patch("alignment.os.path.exists", side_effect=lambda path: path.replace("\\", "/") in {
                 "D:/assets/models/rife",
                 "D:/assets/models/rife/pkg/rife-v4.6",
             }), \
             mock.patch("alignment.os.walk", return_value=[
                 ("D:/assets/models/rife/pkg", [], ["rife-ncnn-vulkan.exe"])
             ]):
            exe_path, model_path = alignment.get_rife_executable()

        self.assertEqual("D:/assets/models/rife/pkg/rife-ncnn-vulkan.exe", exe_path.replace("\\", "/"))
        self.assertEqual("D:/assets/models/rife/pkg/rife-v4.6", model_path.replace("\\", "/"))

    def test_apply_rife_interpolation_uses_executable_directory_as_cwd(self) -> None:
        fake_probe = {
            "format": {"duration": "2.0"},
            "streams": [{"codec_type": "video", "nb_frames": "60", "r_frame_rate": "30/1"}],
        }

        run_calls: list[object] = []

        def fake_run_ffmpeg(stream, quiet=True, overwrite_output=True):
            run_calls.append(stream)

        with mock.patch("alignment.get_rife_executable", return_value=(
            "D:/assets/models/rife/pkg/rife-ncnn-vulkan.exe",
            "D:/assets/models/rife/pkg/rife-v4.6",
        )), \
             mock.patch("alignment.probe_media", return_value=fake_probe), \
             mock.patch("alignment.get_project_root", return_value="C:/repo"), \
             mock.patch("alignment.get_storage_cache_dir", return_value="C:/repo/storage/cache"), \
             mock.patch("alignment.os.makedirs"), \
             mock.patch("alignment.os.path.exists", return_value=True), \
             mock.patch("alignment.os.listdir", return_value=["00000001.png"]), \
             mock.patch("alignment.os.remove"), \
             mock.patch("alignment.ffmpeg.input", return_value=SimpleNamespace(output=lambda *args, **kwargs: "ffmpeg-stream")), \
             mock.patch("alignment.run_ffmpeg", side_effect=fake_run_ffmpeg), \
             mock.patch("subprocess.run", return_value=SimpleNamespace(stdout="", stderr="")) as subprocess_run_mock, \
             mock.patch("shutil.rmtree"):
            success = alignment.apply_rife_interpolation("input.mp4", "output.mp4", 3.0)

        self.assertTrue(success)
        self.assertGreaterEqual(len(run_calls), 2)
        cmd = subprocess_run_mock.call_args.args[0]
        self.assertIn("D:/assets/models/rife/pkg/rife-v4.6", [part.replace("\\", "/") for part in cmd])
        self.assertEqual("D:/assets/models/rife/pkg", subprocess_run_mock.call_args.kwargs["cwd"].replace("\\", "/"))


if __name__ == "__main__":
    unittest.main()
