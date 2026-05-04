import pathlib
import sys
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from model_profiles import ASR_MODEL_PROFILES, MODELS_ROOT, TTS_MODEL_PROFILES


class ModelProfilesTests(unittest.TestCase):
    def test_asr_model_candidates_only_point_to_models_root(self) -> None:
        expected_root = str(pathlib.Path(MODELS_ROOT).resolve())
        for service_profiles in ASR_MODEL_PROFILES.values():
            for profile in service_profiles.values():
                for key in ["candidates", "vad_candidates", "punc_candidates"]:
                    for candidate in profile.get(key, []):
                        candidate_path = pathlib.Path(candidate)
                        if ".cache" in candidate_path.parts or "modelscope" in candidate_path.parts:
                            continue
                        self.assertEqual(expected_root, str(candidate_path.parent.resolve()))

    def test_indextts_profile_uses_current_models_root(self) -> None:
        candidates = TTS_MODEL_PROFILES["indextts"]["standard"]["model_dir_candidates"]
        self.assertEqual([str(pathlib.Path(MODELS_ROOT) / "index-tts")], candidates)


if __name__ == "__main__":
    unittest.main()
