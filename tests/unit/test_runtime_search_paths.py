import pathlib
import sys
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from bootstrap.path_layout import get_faster_whisper_runtime_search_roots


class RuntimeSearchPathTests(unittest.TestCase):
    def test_faster_whisper_runtime_roots_prioritize_current_layout(self) -> None:
        roots = get_faster_whisper_runtime_search_roots(
            "C:/repo",
            backend_dir="C:/repo/services/media_pipeline",
            legacy_project_root="C:/repo/services",
            extra_root="C:/custom/fw",
        )

        normalized = [path.replace("\\", "/") for path in roots]
        self.assertEqual("C:/custom/fw", normalized[0])
        self.assertEqual("C:/repo/models/faster_whisper_runtime", normalized[1])
        self.assertEqual("C:/repo/resources/media_tools/faster_whisper", normalized[2])
        self.assertIn("C:/repo/services/resource/bin/Faster-Whisper-XXL", normalized)
        self.assertEqual(len(normalized), len(set(normalized)))


if __name__ == "__main__":
    unittest.main()
