import pathlib
import sys
import unittest
from unittest.mock import patch


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import qwen_asr_service


class _FakeQwen3ASRModel:
    init_calls: list[dict] = []

    @classmethod
    def from_pretrained(cls, model_path, **kwargs):
        payload = {"model_path": model_path, **kwargs}
        cls.init_calls.append(payload)
        return payload


class QwenAsrRuntimeCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        qwen_asr_service.cleanup_qwen_asr_runtime()
        _FakeQwen3ASRModel.init_calls = []

    def tearDown(self) -> None:
        qwen_asr_service.cleanup_qwen_asr_runtime()

    def test_reuses_cached_instance_for_same_runtime_signature(self) -> None:
        with patch.object(qwen_asr_service, "Qwen3ASRModel", _FakeQwen3ASRModel):
            first = qwen_asr_service._get_qwen_asr_instance(
                model_path="C:/models/qwen-asr",
                aligner_path="C:/models/qwen-aligner",
                device="cuda",
                max_inference_batch_size=32,
                max_new_tokens=256,
            )
            second = qwen_asr_service._get_qwen_asr_instance(
                model_path="C:/models/qwen-asr",
                aligner_path="C:/models/qwen-aligner",
                device="cuda",
                max_inference_batch_size=32,
                max_new_tokens=256,
            )

        self.assertIs(first, second)
        self.assertEqual(1, len(_FakeQwen3ASRModel.init_calls))

    def test_rebuilds_cached_instance_when_runtime_signature_changes(self) -> None:
        with patch.object(qwen_asr_service, "Qwen3ASRModel", _FakeQwen3ASRModel):
            first = qwen_asr_service._get_qwen_asr_instance(
                model_path="C:/models/qwen-asr",
                aligner_path="C:/models/qwen-aligner",
                device="cuda",
                max_inference_batch_size=32,
                max_new_tokens=256,
            )
            second = qwen_asr_service._get_qwen_asr_instance(
                model_path="C:/models/qwen-asr",
                aligner_path="C:/models/qwen-aligner",
                device="cpu",
                max_inference_batch_size=32,
                max_new_tokens=256,
            )

        self.assertIsNot(first, second)
        self.assertEqual(2, len(_FakeQwen3ASRModel.init_calls))


if __name__ == "__main__":
    unittest.main()
