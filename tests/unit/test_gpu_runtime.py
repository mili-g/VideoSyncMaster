import pathlib
import sys
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import gpu_runtime


class GpuRuntimeTests(unittest.TestCase):
    def test_classify_single_gpu_tier_critical(self):
        tier = gpu_runtime.classify_single_gpu_tier({"free_gb": 2.0, "total_gb": 12.0})
        self.assertEqual("critical", tier)

    def test_classify_single_gpu_tier_tight(self):
        tier = gpu_runtime.classify_single_gpu_tier({"free_gb": 3.5, "total_gb": 12.0})
        self.assertEqual("tight", tier)

    def test_classify_single_gpu_tier_roomy(self):
        tier = gpu_runtime.classify_single_gpu_tier({"free_gb": 18.0, "total_gb": 24.0})
        self.assertEqual("roomy", tier)

    def test_format_gpu_snapshot_includes_tier(self):
        text = gpu_runtime.format_gpu_snapshot(
            {
                "free_gb": 8.0,
                "total_gb": 12.0,
                "requested_batch_size": 6,
                "adaptive_batch_size": 2,
            }
        )
        self.assertIn("tier", text)
        self.assertIn("batch 6 -> 2", text)


if __name__ == "__main__":
    unittest.main()
