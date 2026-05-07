import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from bootstrap import triton_windows_compat


class TritonWindowsCompatTests(unittest.TestCase):
    def test_patch_triton_winsdk_registry_bug_rewrites_buggy_return_value(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = pathlib.Path(temp_dir)
            windows_utils_path = temp_path / "windows_utils.py"
            windows_utils_path.write_text(
                triton_windows_compat._BUGGY_SNIPPET + "\n    return winsdk_base_path, version\n",
                encoding="utf-8",
            )

            with patch("bootstrap.triton_windows_compat.os.name", "nt"):
                with patch(
                    "bootstrap.triton_windows_compat._resolve_triton_windows_utils_path",
                    return_value=windows_utils_path,
                ):
                    patched = triton_windows_compat.patch_triton_winsdk_registry_bug()

            self.assertTrue(patched)
            content = windows_utils_path.read_text(encoding="utf-8")
            self.assertIn("except OSError:\n        return None, None\n", content)

    def test_patch_triton_winsdk_registry_bug_is_noop_when_already_fixed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = pathlib.Path(temp_dir)
            windows_utils_path = temp_path / "windows_utils.py"
            windows_utils_path.write_text(triton_windows_compat._FIXED_SNIPPET, encoding="utf-8")

            with patch("bootstrap.triton_windows_compat.os.name", "nt"):
                with patch(
                    "bootstrap.triton_windows_compat._resolve_triton_windows_utils_path",
                    return_value=windows_utils_path,
                ):
                    patched = triton_windows_compat.patch_triton_winsdk_registry_bug()

            self.assertFalse(patched)


if __name__ == "__main__":
    unittest.main()
