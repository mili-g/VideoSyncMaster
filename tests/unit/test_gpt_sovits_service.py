import pathlib
import sys
import unittest
from unittest.mock import patch
from io import StringIO
from io import BytesIO
import urllib.error

import numpy as np
import soundfile as sf
import tempfile


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import gpt_sovits_service


class GptSovitsServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        gpt_sovits_service._clear_learned_official_fast_batch_caps()  # type: ignore[attr-defined]

    def tearDown(self) -> None:
        gpt_sovits_service._clear_learned_official_fast_batch_caps()  # type: ignore[attr-defined]

    def test_group_batch_tasks_groups_by_reference_and_prompt(self):
        with patch.object(gpt_sovits_service, "_get_cached_gpu_snapshot", return_value={"free_gb": 10.8, "total_gb": 12.0}):
            groups = gpt_sovits_service._group_batch_tasks(  # type: ignore[attr-defined]
                [
                    {
                        "index": 0,
                        "text": "hello",
                        "output_path": "a.wav",
                        "ref_audio_path": "shared.wav",
                        "ref_text": "prompt one",
                    },
                    {
                        "index": 1,
                        "text": "world",
                        "output_path": "b.wav",
                        "ref_audio_path": "shared.wav",
                        "ref_text": "prompt one",
                    },
                    {
                        "index": 2,
                        "text": "split",
                        "output_path": "c.wav",
                        "ref_audio_path": "other.wav",
                        "ref_text": "prompt two",
                    },
                ],
                language="English",
                base_kwargs={"gpt_sovits_prompt_lang": "zh"},
            )

        self.assertEqual(2, len(groups))
        self.assertEqual(2, len(groups[0]["items"]))
        self.assertEqual("shared.wav", groups[0]["ref_audio_path"])
        self.assertEqual("prompt one", groups[0]["prompt_text"])
        self.assertEqual("other.wav", groups[1]["ref_audio_path"])
        self.assertEqual(1, len(groups[1]["items"]))

    def test_estimate_text_unit_count_ignores_punctuation_and_space(self):
        units = gpt_sovits_service._estimate_text_unit_count("Hello, 世界 !")  # type: ignore[attr-defined]
        self.assertEqual(7, units)

    def test_normalize_gpt_sovits_text_expands_acronym_in_mixed_script_sentence(self):
        normalized = gpt_sovits_service._normalize_gpt_sovits_text(  # type: ignore[attr-defined]
            "具备AI编程的经验",
            language="Chinese",
        )

        self.assertEqual("具备 A I 编程的经验。", normalized)

    def test_group_batch_tasks_splits_short_texts_into_quality_chunks(self):
        with patch.object(gpt_sovits_service, "_get_cached_gpu_snapshot", return_value={"free_gb": 10.8, "total_gb": 12.0}):
            groups = gpt_sovits_service._group_batch_tasks(  # type: ignore[attr-defined]
                [
                    {"index": 0, "text": "短句一", "output_path": "a.wav", "ref_audio_path": "shared.wav", "ref_text": "prompt one"},
                    {"index": 1, "text": "短句二", "output_path": "b.wav", "ref_audio_path": "shared.wav", "ref_text": "prompt one"},
                    {"index": 2, "text": "短句三", "output_path": "c.wav", "ref_audio_path": "shared.wav", "ref_text": "prompt one"},
                ],
                language="English",
                base_kwargs={"gpt_sovits_prompt_lang": "zh", "batch_size": 8},
            )

        self.assertEqual(2, len(groups))
        self.assertEqual("short", groups[0]["quality_bucket"])
        self.assertEqual(2, len(groups[0]["items"]))
        self.assertEqual(1, len(groups[1]["items"]))
        self.assertFalse(groups[0]["payload_overrides"]["gpt_sovits_parallel_infer"])

    def test_group_batch_tasks_uses_fast_shared_reference_profile_for_narration(self):
        with patch.object(gpt_sovits_service, "_get_cached_gpu_snapshot", return_value={"free_gb": 10.8, "total_gb": 12.0}):
            groups = gpt_sovits_service._group_batch_tasks(  # type: ignore[attr-defined]
                [
                    {"index": 0, "text": "短句一", "output_path": "a.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 1, "text": "短句二", "output_path": "b.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 2, "text": "短句三", "output_path": "c.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 3, "text": "短句四", "output_path": "d.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                ],
                language="English",
                base_kwargs={"gpt_sovits_prompt_lang": "zh", "batch_size": 8, "voice_mode": "narration"},
            )

        self.assertEqual(1, len(groups))
        self.assertEqual(4, len(groups[0]["items"]))
        self.assertTrue(groups[0]["payload_overrides"]["gpt_sovits_parallel_infer"])
        self.assertEqual(32, groups[0]["payload_overrides"]["gpt_sovits_sample_steps"])
        self.assertEqual("cut0", groups[0]["payload_overrides"]["gpt_sovits_text_split_method"])

    def test_group_batch_tasks_uses_official_fast_mode_for_shared_reference_narration(self):
        with patch.object(gpt_sovits_service, "_get_cached_gpu_snapshot", return_value={"free_gb": 10.8, "total_gb": 12.0}):
            groups = gpt_sovits_service._group_batch_tasks(  # type: ignore[attr-defined]
                [
                    {"index": 0, "text": "短句一", "output_path": "a.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 1, "text": "短句二", "output_path": "b.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 2, "text": "短句三", "output_path": "c.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 3, "text": "短句四", "output_path": "d.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 4, "text": "短句五", "output_path": "e.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 5, "text": "短句六", "output_path": "f.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                ],
                language="English",
                base_kwargs={"gpt_sovits_prompt_lang": "zh", "batch_size": 8, "voice_mode": "narration", "gpt_sovits_official_fast_mode": True},
            )

        self.assertEqual(1, len(groups))
        self.assertEqual(6, len(groups[0]["items"]))
        self.assertTrue(groups[0]["payload_overrides"]["gpt_sovits_parallel_infer"])
        self.assertEqual(28, groups[0]["payload_overrides"]["gpt_sovits_sample_steps"])
        self.assertTrue(groups[0]["payload_overrides"]["gpt_sovits_official_fast_mode"])
        self.assertEqual(6, groups[0]["payload_overrides"]["batch_size"])
        self.assertEqual(1.2, groups[0]["payload_overrides"]["gpt_sovits_batch_threshold"])

    def test_group_batch_tasks_official_fast_mode_allows_larger_requested_batch_size(self):
        with patch.object(gpt_sovits_service, "_get_cached_gpu_snapshot", return_value={"free_gb": 18.0, "total_gb": 24.0}):
            groups = gpt_sovits_service._group_batch_tasks(  # type: ignore[attr-defined]
                [
                    {"index": 0, "text": "短句一", "output_path": "a.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 1, "text": "短句二", "output_path": "b.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 2, "text": "短句三", "output_path": "c.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 3, "text": "短句四", "output_path": "d.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 4, "text": "短句五", "output_path": "e.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 5, "text": "短句六", "output_path": "f.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 6, "text": "短句七", "output_path": "g.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 7, "text": "短句八", "output_path": "h.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 8, "text": "短句九", "output_path": "i.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 9, "text": "短句十", "output_path": "j.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                ],
                language="English",
                base_kwargs={"gpt_sovits_prompt_lang": "zh", "batch_size": 12, "voice_mode": "narration", "gpt_sovits_official_fast_mode": True},
            )

        self.assertEqual(1, len(groups))
        self.assertEqual(10, len(groups[0]["items"]))
        self.assertEqual(12, groups[0]["payload_overrides"]["batch_size"])

    def test_group_batch_tasks_official_fast_mode_uses_learned_batch_cap(self):
        gpt_sovits_service._remember_official_fast_batch_cap(  # type: ignore[attr-defined]
            gpu_tier="balanced",
            voice_mode="narration",
            batch_size=3,
        )
        with patch.object(gpt_sovits_service, "_get_cached_gpu_snapshot", return_value={"free_gb": 10.8, "total_gb": 12.0}):
            groups = gpt_sovits_service._group_batch_tasks(  # type: ignore[attr-defined]
                [
                    {"index": 0, "text": "短句一", "output_path": "a.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 1, "text": "短句二", "output_path": "b.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 2, "text": "短句三", "output_path": "c.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 3, "text": "短句四", "output_path": "d.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 4, "text": "短句五", "output_path": "e.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                    {"index": 5, "text": "短句六", "output_path": "f.wav", "ref_audio_path": "resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav", "ref_text": "prompt one"},
                ],
                language="English",
                base_kwargs={"gpt_sovits_prompt_lang": "zh", "batch_size": 8, "voice_mode": "narration", "gpt_sovits_official_fast_mode": True},
            )

        self.assertEqual(2, len(groups))
        self.assertEqual([3, 3], [len(group["items"]) for group in groups])
        self.assertEqual(3, groups[0]["payload_overrides"]["batch_size"])

    def test_build_request_payload_relaxes_batch_cap_in_official_fast_mode(self):
        payload = gpt_sovits_service._build_request_payload(  # type: ignore[attr-defined]
            "hello",
            "shared.wav",
            "English",
            {
                "gpt_sovits_prompt_text": "prompt one",
                "gpt_sovits_prompt_lang": "zh",
                "batch_size": 12,
                "gpt_sovits_official_fast_mode": True,
            },
        )

        self.assertEqual(12, payload["batch_size"])
        self.assertEqual(0.0001, payload["fragment_interval"])
        self.assertEqual(1.2, payload["batch_threshold"])
        self.assertEqual("cut0", payload["text_split_method"])
        self.assertEqual(28, payload["sample_steps"])
        self.assertFalse(payload["use_cuda_graph"])

    def test_build_request_payload_enables_cuda_graph_for_single_official_fast_request(self):
        payload = gpt_sovits_service._build_request_payload(  # type: ignore[attr-defined]
            "hello",
            "shared.wav",
            "English",
            {
                "gpt_sovits_prompt_text": "prompt one",
                "gpt_sovits_prompt_lang": "zh",
                "batch_size": 1,
                "gpt_sovits_official_fast_mode": True,
            },
        )

        self.assertTrue(payload["use_cuda_graph"])

    def test_resolve_builtin_reference_maps_builtin_voice_to_repo_asset(self):
        fake_root = pathlib.Path("H:/VideoSyncMaster")
        with patch.object(gpt_sovits_service, "_project_root", return_value=fake_root):
            ref_audio, prompt_text, prompt_lang = gpt_sovits_service.resolve_builtin_reference(
                "builtin://gpt-sovits/jing-yuan-cn",
                "",
                "",
            )

        self.assertTrue(str(ref_audio).endswith("resources\\voice_refs\\gpt_sovits\\jing_yuan_cn.wav"))
        self.assertEqual("zh", prompt_lang)
        self.assertIn("景元", prompt_text)

    def test_normalize_output_loudness_boosts_low_level_audio(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            audio_path = pathlib.Path(temp_dir) / "quiet.wav"
            sample_rate = 24000
            waveform = np.full(sample_rate, 0.02, dtype=np.float32)
            sf.write(audio_path, waveform, sample_rate)

            gain = gpt_sovits_service._normalize_output_loudness(str(audio_path))  # type: ignore[attr-defined]
            normalized, _ = sf.read(audio_path, dtype="float32")

        self.assertIsNotNone(gain)
        self.assertGreater(float(gain), 1.0)
        self.assertGreater(float(np.max(np.abs(normalized))), 0.02)

    def test_is_oom_error_message_detects_cuda_oom(self):
        self.assertTrue(gpt_sovits_service._is_oom_error_message("CUDA out of memory"))  # type: ignore[attr-defined]
        self.assertTrue(gpt_sovits_service._is_oom_error_message("torch.OutOfMemoryError: CUDA out of memory"))  # type: ignore[attr-defined]
        self.assertFalse(gpt_sovits_service._is_oom_error_message("network timeout"))  # type: ignore[attr-defined]

    def test_build_low_load_single_kwargs_forces_conservative_profile(self):
        adjusted = gpt_sovits_service._build_low_load_single_kwargs(  # type: ignore[attr-defined]
            {"batch_size": 8, "gpt_sovits_parallel_infer": True, "gpt_sovits_sample_steps": 32},
            "这是一个短句",
        )

        self.assertEqual(1, adjusted["batch_size"])
        self.assertFalse(adjusted["gpt_sovits_parallel_infer"])
        self.assertFalse(adjusted["gpt_sovits_split_bucket"])
        self.assertGreaterEqual(adjusted["gpt_sovits_sample_steps"], 40)
        self.assertEqual("cut0", adjusted["gpt_sovits_text_split_method"])

    def test_build_text_fidelity_single_kwargs_uses_high_fidelity_profile_for_mixed_script_short_text(self):
        adjusted = gpt_sovits_service._build_text_fidelity_single_kwargs(  # type: ignore[attr-defined]
            {"batch_size": 6, "gpt_sovits_parallel_infer": True, "gpt_sovits_sample_steps": 32, "temperature": 1.0, "top_p": 1.0},
            "具备 A I 编程的经验。",
            attempt=1,
        )

        self.assertEqual(1, adjusted["batch_size"])
        self.assertFalse(adjusted["gpt_sovits_parallel_infer"])
        self.assertFalse(adjusted["gpt_sovits_split_bucket"])
        self.assertEqual("cut0", adjusted["gpt_sovits_text_split_method"])
        self.assertGreaterEqual(adjusted["gpt_sovits_sample_steps"], 52)
        self.assertLessEqual(adjusted["temperature"], 0.74)
        self.assertLessEqual(adjusted["top_p"], 0.90)

    def test_validate_gpt_sovits_duration_requires_more_time_for_mixed_script_acronym_text(self):
        with patch.object(gpt_sovits_service, "_validate_output", return_value=0.50):
            with self.assertRaises(RuntimeError):
                gpt_sovits_service._validate_gpt_sovits_duration(  # type: ignore[attr-defined]
                    "dummy.wav",
                    "具备 A I 编程的经验。",
                )

    def test_measure_text_coverage_detects_missing_prefix_content(self):
        coverage = gpt_sovits_service._measure_text_coverage(  # type: ignore[attr-defined]
            "以及理解如何与 AI 协作。",
            "AI协作",
        )

        self.assertLess(coverage, 0.6)

    def test_measure_cjk_skeleton_coverage_tolerates_latin_term_asr_homophone(self):
        coverage = gpt_sovits_service._measure_cjk_skeleton_coverage(  # type: ignore[attr-defined]
            "我将介绍 Python 中的数据类型、数据结构。",
            "我将介绍牌坛中的数据类型、数据结构。",
        )

        self.assertGreaterEqual(coverage, 0.92)

    def test_verify_gpt_sovits_text_fidelity_is_disabled(self):
        with patch.object(
            gpt_sovits_service,
            "_transcribe_audio_for_text_verification",
            return_value="AI协作",
        ):
            coverage = gpt_sovits_service._verify_gpt_sovits_text_fidelity(  # type: ignore[attr-defined]
                "dummy.wav",
                "以及理解如何与 AI 协作。",
                language="Chinese",
            )

        self.assertEqual(1.0, coverage)

    def test_run_gpt_sovits_request_retries_after_text_fidelity_failure(self):
        calls = {"count": 0}

        class _Response:
            def __init__(self_inner):
                self_inner._buffer = BytesIO(b"RIFFdemo")

            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, exc_type, exc, tb):
                return False

            def read(self_inner, size=-1):
                return self_inner._buffer.read(size)

        def fake_urlopen(request, timeout=600):
            calls["count"] += 1
            return _Response()

        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = pathlib.Path(temp_dir) / "segment.wav"
            with patch.object(gpt_sovits_service.urllib.request, "urlopen", side_effect=fake_urlopen), patch.object(
                gpt_sovits_service,
                "_SERVER_PORT",
                9999,
            ), patch.object(
                gpt_sovits_service,
                "_normalize_output_loudness",
                return_value=None,
            ), patch.object(
                gpt_sovits_service,
                "_validate_gpt_sovits_duration",
                return_value=1.0,
            ), patch.object(
                gpt_sovits_service,
                "_verify_gpt_sovits_text_fidelity",
                side_effect=[RuntimeError("GPT-SoVITS 文本覆盖不足"), 1.0],
            ):
                success = gpt_sovits_service._run_gpt_sovits_request(  # type: ignore[attr-defined]
                    "以及理解如何与AI协作",
                    "ref.wav",
                    str(output_path),
                    language="Chinese",
                    gpt_sovits_prompt_text="提示文本",
                    gpt_sovits_prompt_lang="zh",
                )

        self.assertTrue(success)
        self.assertEqual(2, calls["count"])

    def test_compute_gpt_sovits_dynamic_limits_scales_by_gpu_snapshot(self):
        roomy = gpt_sovits_service._compute_gpt_sovits_dynamic_limits(  # type: ignore[attr-defined]
            {"free_gb": 18.0, "total_gb": 24.0},
            text_units=32,
            bucket_name="long",
        )
        tight = gpt_sovits_service._compute_gpt_sovits_dynamic_limits(  # type: ignore[attr-defined]
            {"free_gb": 3.0, "total_gb": 8.0},
            text_units=32,
            bucket_name="long",
        )

        self.assertEqual("roomy", roomy["tier"])
        self.assertGreaterEqual(roomy["max_batch_size"], 4)
        self.assertTrue(roomy["allow_parallel_infer"])
        self.assertEqual("tight", tight["tier"])
        self.assertLessEqual(tight["max_batch_size"], 2)
        self.assertFalse(tight["allow_parallel_infer"])

    def test_apply_dynamic_batch_profile_uses_cached_snapshot(self):
        with patch.object(
            gpt_sovits_service,
            "_get_cached_gpu_snapshot",
            return_value={"free_gb": 3.2, "total_gb": 12.0},
        ):
            adjusted, profile = gpt_sovits_service._apply_dynamic_batch_profile(  # type: ignore[attr-defined]
                {"batch_size": 6, "gpt_sovits_parallel_infer": True, "gpt_sovits_sample_steps": 32},
                bucket_name="medium",
                text_units=20,
            )

        self.assertEqual("tight", profile["tier"])
        self.assertLessEqual(adjusted["batch_size"], 2)
        self.assertFalse(adjusted["gpt_sovits_parallel_infer"])
        self.assertGreaterEqual(adjusted["gpt_sovits_sample_steps"], 40)

    def test_cleanup_residual_servers_kills_detected_pids(self):
        killed = []
        with patch.object(gpt_sovits_service, "_find_residual_server_pids", return_value=[123, 456]), patch.object(
            gpt_sovits_service, "_kill_process_tree", side_effect=lambda pid: killed.append(pid)
        ):
            gpt_sovits_service._cleanup_residual_servers()  # type: ignore[attr-defined]

        self.assertEqual([123, 456], killed)

    def test_find_residual_server_pids_matches_windows_process_list(self):
        fake_service_root = pathlib.Path("H:/VideoSyncMaster/runtime/gpt_sovits")
        fake_script_path = pathlib.Path("H:/VideoSyncMaster/services/media_pipeline/gpt_sovits_api_server.py")
        with patch.object(gpt_sovits_service, "_service_root", return_value=fake_service_root), patch.object(
            gpt_sovits_service, "_custom_api_server_path", return_value=fake_script_path
        ), patch.object(
            gpt_sovits_service, "_list_windows_python_processes",
            return_value=[
                (111, r"H:\VideoSyncMaster\runtime\gpt_sovits\venv\Scripts\python.exe H:\VideoSyncMaster\services\media_pipeline\gpt_sovits_api_server.py -r H:\VideoSyncMaster\runtime\gpt_sovits\repo"),
                (222, r"C:\Python311\python.exe other_script.py"),
            ],
        ), patch.object(gpt_sovits_service, "os") as mocked_os, patch.object(
            gpt_sovits_service, "_read_server_state", return_value={}
        ):
            mocked_os.name = "nt"
            mocked_os.getpid.return_value = 999
            pids = gpt_sovits_service._find_residual_server_pids()  # type: ignore[attr-defined]

        self.assertEqual([111], pids)

    def test_find_residual_server_pids_ignores_stale_state_pid(self):
        fake_service_root = pathlib.Path("H:/VideoSyncMaster/runtime/gpt_sovits")
        fake_script_path = pathlib.Path("H:/VideoSyncMaster/services/media_pipeline/gpt_sovits_api_server.py")
        with patch.object(gpt_sovits_service, "_service_root", return_value=fake_service_root), patch.object(
            gpt_sovits_service, "_custom_api_server_path", return_value=fake_script_path
        ), patch.object(
            gpt_sovits_service, "_list_windows_python_processes", return_value=[]
        ), patch.object(gpt_sovits_service, "os") as mocked_os, patch.object(
            gpt_sovits_service, "_read_server_state", return_value={"pid": 555}
        ), patch.object(
            gpt_sovits_service, "_process_exists", return_value=False
        ):
            mocked_os.name = "nt"
            mocked_os.getpid.return_value = 999
            pids = gpt_sovits_service._find_residual_server_pids()  # type: ignore[attr-defined]

        self.assertEqual([], pids)

    def test_should_emit_official_fast_progress_throttles_success_updates(self):
        self.assertFalse(
            gpt_sovits_service._should_emit_official_fast_progress(  # type: ignore[attr-defined]
                completed=3,
                progress_total=20,
                group_size=10,
                success=True,
            )
        )
        self.assertTrue(
            gpt_sovits_service._should_emit_official_fast_progress(  # type: ignore[attr-defined]
                completed=10,
                progress_total=20,
                group_size=10,
                success=True,
            )
        )

    def test_should_emit_official_fast_progress_keeps_failures_and_final_update(self):
        self.assertTrue(
            gpt_sovits_service._should_emit_official_fast_progress(  # type: ignore[attr-defined]
                completed=3,
                progress_total=20,
                group_size=10,
                success=False,
            )
        )
        self.assertTrue(
            gpt_sovits_service._should_emit_official_fast_progress(  # type: ignore[attr-defined]
                completed=20,
                progress_total=20,
                group_size=10,
                success=True,
            )
        )

    def test_run_batch_gpt_sovits_request_splits_group_after_oom(self):
        group = {
            "ref_audio_path": "shared.wav",
            "prompt_text": "prompt one",
            "prompt_lang": "zh",
            "language": "English",
            "items": [
                {"index": 0, "text": "a", "output_path": "a.wav"},
                {"index": 1, "text": "b", "output_path": "b.wav"},
                {"index": 2, "text": "c", "output_path": "c.wav"},
                {"index": 3, "text": "d", "output_path": "d.wav"},
            ],
            "quality_bucket": "official_fast",
            "payload_overrides": {"batch_size": 6, "gpt_sovits_official_fast_mode": True},
            "gpu_tier": "balanced",
        }

        calls = {"count": 0}

        class _FakeHttpError(urllib.error.HTTPError):
            def __init__(self):
                super().__init__("http://127.0.0.1", 400, "bad", {}, None)

            def read(self):
                return b'{"message":"tts batch failed","Exception":"CUDA error: out of memory"}'

        def fake_urlopen(request, timeout=1800):
            calls["count"] += 1
            payload = __import__("json").loads(request.data.decode("utf-8"))
            if calls["count"] == 1:
                raise _FakeHttpError()

            body = {
                "results": [
                    {
                        "index": item["index"],
                        "success": True,
                        "audio_path": item["output_path"],
                        "duration": 1.0,
                    }
                    for item in payload["items"]
                ]
            }

            class _Response:
                def __enter__(self_inner):
                    return self_inner

                def __exit__(self_inner, exc_type, exc, tb):
                    return False

                def read(self_inner):
                    return __import__("json").dumps(body).encode("utf-8")

            return _Response()

        with patch.object(gpt_sovits_service.urllib.request, "urlopen", side_effect=fake_urlopen), patch.object(
            gpt_sovits_service, "_stop_server"
        ), patch.object(gpt_sovits_service, "_start_server"), patch.object(
            gpt_sovits_service, "_SERVER_PORT", 9999
        ):
            results = gpt_sovits_service._run_batch_gpt_sovits_request(group, base_kwargs={  # type: ignore[attr-defined]
                "gpt_sovits_prompt_text": "prompt one",
                "gpt_sovits_prompt_lang": "zh",
                "gpt_sovits_official_fast_mode": True,
            })

        self.assertEqual(4, len(results))
        self.assertEqual({0, 1, 2, 3}, {int(item["index"]) for item in results})
        self.assertGreaterEqual(calls["count"], 3)
        self.assertEqual(
            2,
            gpt_sovits_service._get_learned_official_fast_batch_cap(gpu_tier="balanced", voice_mode="narration"),  # type: ignore[attr-defined]
        )

    def test_cleanup_gpt_sovits_runtime_clears_learned_batch_caps(self):
        gpt_sovits_service._remember_official_fast_batch_cap(  # type: ignore[attr-defined]
            gpu_tier="balanced",
            voice_mode="narration",
            batch_size=4,
        )

        with patch.object(gpt_sovits_service, "_stop_server"):
            gpt_sovits_service.cleanup_gpt_sovits_runtime()

        self.assertIsNone(
            gpt_sovits_service._get_learned_official_fast_batch_cap(gpu_tier="balanced", voice_mode="narration")  # type: ignore[attr-defined]
        )

    def test_warmup_server_marks_state_and_cleans_artifacts(self):
        payload = {"items": [{"index": 0, "text": "warmup", "output_path": "dummy.wav"}]}

        class _Response:
            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, exc_type, exc, tb):
                return False

            def read(self_inner):
                return b'{"results":[{"index":0,"success":true}]}'

        with tempfile.TemporaryDirectory() as temp_dir:
            warmup_path = pathlib.Path(temp_dir) / "warmup_0.wav"
            warmup_path.write_bytes(b"test")
            gpt_sovits_service._SERVER_PORT = 9999  # type: ignore[attr-defined]
            gpt_sovits_service._SERVER_WARMED = False  # type: ignore[attr-defined]
            with patch.object(gpt_sovits_service, "_build_warmup_payload", return_value=(payload, [warmup_path])), patch.object(
                gpt_sovits_service.urllib.request, "urlopen", return_value=_Response()
            ):
                gpt_sovits_service._warmup_server()  # type: ignore[attr-defined]

            self.assertTrue(gpt_sovits_service._SERVER_WARMED)  # type: ignore[attr-defined]
            self.assertFalse(warmup_path.exists())

    def test_warmup_server_skips_when_real_request_is_active(self):
        gpt_sovits_service._SERVER_PORT = 9999  # type: ignore[attr-defined]
        gpt_sovits_service._SERVER_WARMED = False  # type: ignore[attr-defined]
        gpt_sovits_service._SERVER_ACTIVE_REAL_REQUESTS = 1  # type: ignore[attr-defined]
        gpt_sovits_service._SERVER_STARTED_AT = 10.0  # type: ignore[attr-defined]
        gpt_sovits_service._SERVER_LAST_REAL_REQUEST_AT = 11.0  # type: ignore[attr-defined]
        with patch.object(gpt_sovits_service.urllib.request, "urlopen") as mocked_urlopen:
            gpt_sovits_service._warmup_server()  # type: ignore[attr-defined]

        mocked_urlopen.assert_not_called()

    def test_bootstrap_gpt_sovits_runtime_starts_server_before_status(self):
        with patch.object(gpt_sovits_service, "_ensure_runtime_ready"), patch.object(
            gpt_sovits_service, "_start_server"
        ) as mocked_start_server, patch.object(
            gpt_sovits_service, "get_gpt_sovits_runtime_status", return_value=(True, None)
        ):
            available, detail = gpt_sovits_service.bootstrap_gpt_sovits_runtime()

        self.assertTrue(available)
        self.assertIsNone(detail)
        mocked_start_server.assert_called_once()

    def test_launch_background_warmup_starts_daemon_thread_once(self):
        started = {"count": 0}

        class _FakeThread:
            def __init__(self, target=None, name=None, daemon=None):
                self.target = target
                self.name = name
                self.daemon = daemon
                self._alive = False

            def is_alive(self):
                return self._alive

            def start(self):
                self._alive = True
                started["count"] += 1

        gpt_sovits_service._SERVER_PORT = 9999  # type: ignore[attr-defined]
        gpt_sovits_service._SERVER_WARMED = False  # type: ignore[attr-defined]
        gpt_sovits_service._SERVER_WARMUP_THREAD = None  # type: ignore[attr-defined]
        with patch.object(gpt_sovits_service.threading, "Thread", _FakeThread):
            gpt_sovits_service._launch_background_warmup()  # type: ignore[attr-defined]
            gpt_sovits_service._launch_background_warmup()  # type: ignore[attr-defined]

        self.assertEqual(1, started["count"])

    def test_run_batch_success_does_not_shrink_existing_learned_cap_for_tail_group(self):
        gpt_sovits_service._remember_official_fast_batch_cap(  # type: ignore[attr-defined]
            gpu_tier="balanced",
            voice_mode="narration",
            batch_size=6,
        )
        group = {
            "ref_audio_path": "shared.wav",
            "prompt_text": "prompt one",
            "prompt_lang": "zh",
            "language": "English",
            "items": [
                {"index": 6, "text": "tail one", "output_path": "g.wav"},
                {"index": 7, "text": "tail two", "output_path": "h.wav"},
            ],
            "quality_bucket": "official_fast",
            "payload_overrides": {"batch_size": 6, "gpt_sovits_official_fast_mode": True},
            "gpu_tier": "balanced",
        }

        def fake_urlopen(request, timeout=1800):
            payload = __import__("json").loads(request.data.decode("utf-8"))
            body = {
                "results": [
                    {
                        "index": item["index"],
                        "success": True,
                        "audio_path": item["output_path"],
                        "duration": 1.0,
                    }
                    for item in payload["items"]
                ]
            }

            class _Response:
                def __enter__(self_inner):
                    return self_inner

                def __exit__(self_inner, exc_type, exc, tb):
                    return False

                def read(self_inner):
                    return __import__("json").dumps(body).encode("utf-8")

            return _Response()

        with patch.object(gpt_sovits_service.urllib.request, "urlopen", side_effect=fake_urlopen), patch.object(
            gpt_sovits_service, "_SERVER_PORT", 9999
        ):
            results = gpt_sovits_service._run_batch_gpt_sovits_request(group, base_kwargs={  # type: ignore[attr-defined]
                "gpt_sovits_prompt_text": "prompt one",
                "gpt_sovits_prompt_lang": "zh",
                "gpt_sovits_official_fast_mode": True,
            })

        self.assertEqual(2, len(results))
        self.assertEqual(
            6,
            gpt_sovits_service._get_learned_official_fast_batch_cap(gpu_tier="balanced", voice_mode="narration"),  # type: ignore[attr-defined]
        )

    def test_stop_server_closes_log_handle_and_clears_state(self):
        class _FakeProcess:
            def poll(self):
                return 0

        cleared = {"value": False}

        with patch.object(gpt_sovits_service, "_clear_server_state", side_effect=lambda: cleared.__setitem__("value", True)):
            gpt_sovits_service._SERVER_PROCESS = _FakeProcess()  # type: ignore[attr-defined]
            gpt_sovits_service._SERVER_PORT = 9999  # type: ignore[attr-defined]
            gpt_sovits_service._SERVER_LOG_HANDLE = StringIO()  # type: ignore[attr-defined]
            gpt_sovits_service._stop_server()  # type: ignore[attr-defined]

        self.assertIsNone(gpt_sovits_service._SERVER_PROCESS)  # type: ignore[attr-defined]
        self.assertIsNone(gpt_sovits_service._SERVER_PORT)  # type: ignore[attr-defined]
        self.assertIsNone(gpt_sovits_service._SERVER_LOG_HANDLE)  # type: ignore[attr-defined]
        self.assertTrue(cleared["value"])


if __name__ == "__main__":
    unittest.main()
