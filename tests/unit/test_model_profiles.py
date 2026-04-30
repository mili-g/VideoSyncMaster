import pathlib
import sys
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from model_profiles import normalize_asr_model_profile


class ModelProfilesTests(unittest.TestCase):
    def test_funasr_defaults_to_chinese_profile(self) -> None:
        self.assertEqual("zh", normalize_asr_model_profile("funasr"))

    def test_funasr_accepts_standard_profile_explicitly(self) -> None:
        self.assertEqual("standard", normalize_asr_model_profile("funasr", "standard"))


if __name__ == "__main__":
    unittest.main()
