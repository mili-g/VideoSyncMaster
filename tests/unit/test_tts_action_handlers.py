import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import vsm.app.workflows.dub_video_workflow  # noqa: F401
import tts_action_handlers


class TtsActionHandlerTests(unittest.TestCase):
    def test_build_retry_tts_kwargs_enables_cuda_graph_for_gpt_sovits_official_fast_single(self) -> None:
        adjusted = tts_action_handlers._build_retry_tts_kwargs(  # type: ignore[attr-defined]
            {
                "gpt_sovits_official_fast_mode": True,
                "gpt_sovits_batch_threshold": 1.2,
                "gpt_sovits_sample_steps": 28,
            },
            tts_service_name="gptsovits",
            attempt=1,
            use_fallback_reference=False,
        )

        self.assertEqual(1, adjusted["batch_size"])
        self.assertTrue(adjusted["gpt_sovits_use_cuda_graph"])
        self.assertFalse(adjusted["gpt_sovits_parallel_infer"])

    def test_handle_generate_single_tts_passes_gpt_sovits_prompt_text_to_runner(self) -> None:
        captured = {}

        def fake_run_tts(text, ref_audio_path, output_audio, language=None, **kwargs):
            captured["text"] = text
            captured["ref_audio_path"] = ref_audio_path
            captured["output_audio"] = output_audio
            captured["language"] = language
            captured["kwargs"] = kwargs
            pathlib.Path(output_audio).write_bytes(b"RIFFdemo")
            return True

        with tempfile.TemporaryDirectory() as temp_dir:
            work_dir = pathlib.Path(temp_dir)
            ref_audio = work_dir / "ref.wav"
            ref_audio.write_bytes(b"RIFFref")
            output_audio = work_dir / "segment.wav"
            args = types.SimpleNamespace(
                input="demo.mp4",
                output=str(output_audio),
                text="translated speech",
                start=0.0,
                duration=3.2,
                lang="English",
                tts_service="gptsovits",
                strategy="auto_speedup",
                dub_retry_attempts=1,
                ref_audio=str(ref_audio),
                fallback_ref_audio="",
                fallback_ref_text="",
                nearby_ref_audios="[]",
                qwen_ref_text="",
                gpt_sovits_prompt_text="source prompt transcript",
                gpt_sovits_prompt_lang="zh",
                json=True,
            )

            result, _ = tts_action_handlers.handle_generate_single_tts(
                args,
                {"gpt_sovits_prompt_text": "source prompt transcript", "gpt_sovits_prompt_lang": "zh"},
                get_tts_runner=lambda service: (fake_run_tts, object()),
                get_audio_duration=lambda path: 3.2,
                align_audio=lambda *args, **kwargs: False,
                ffmpeg=object(),
                librosa=object(),
                sf=object(),
            )

        self.assertTrue(result["success"])
        self.assertEqual("translated speech", captured["text"])
        self.assertEqual("English", captured["language"])
        self.assertEqual("source prompt transcript", captured["kwargs"]["gpt_sovits_prompt_text"])
        self.assertEqual("zh", captured["kwargs"]["gpt_sovits_prompt_lang"])

    def test_is_retry_reference_usable_rejects_short_gpt_sovits_reference(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            audio_path = pathlib.Path(temp_dir) / "nearby.wav"
            audio_path.write_bytes(b"RIFFdemo")

            usable = tts_action_handlers._is_retry_reference_usable(  # type: ignore[attr-defined]
                {
                    "audio_path": str(audio_path),
                    "ref_text": "reference transcript",
                },
                tts_service_name="gptsovits",
                get_audio_duration=lambda path: 2.4,
            )

        self.assertFalse(usable)

    def test_handle_generate_single_tts_uses_shared_reference_as_primary_for_gpt_sovits(self) -> None:
        captured = {}

        def fake_run_tts(text, ref_audio_path, output_audio, language=None, **kwargs):
            captured["text"] = text
            captured["ref_audio_path"] = ref_audio_path
            captured["output_audio"] = output_audio
            captured["language"] = language
            captured["kwargs"] = kwargs
            pathlib.Path(output_audio).write_bytes(b"RIFFdemo")
            return True

        with tempfile.TemporaryDirectory() as temp_dir:
            work_dir = pathlib.Path(temp_dir)
            fallback_ref_audio = work_dir / "shared_ref.wav"
            fallback_ref_audio.write_bytes(b"RIFFref")
            output_audio = work_dir / "segment.wav"
            args = types.SimpleNamespace(
                input="demo.mp4",
                output=str(output_audio),
                text="translated speech",
                start=0.0,
                duration=0.8,
                lang="English",
                tts_service="gptsovits",
                strategy="auto_speedup",
                dub_retry_attempts=1,
                ref_audio="",
                fallback_ref_audio=str(fallback_ref_audio),
                fallback_ref_text="shared prompt transcript",
                nearby_ref_audios="[]",
                qwen_ref_text="",
                gpt_sovits_prompt_text="segment prompt transcript",
                gpt_sovits_prompt_lang="zh",
                json=True,
            )

            original_extract = tts_action_handlers._extract_reference_audio
            tts_action_handlers._extract_reference_audio = lambda **kwargs: (_ for _ in ()).throw(RuntimeError("should not extract"))
            try:
                result, _ = tts_action_handlers.handle_generate_single_tts(
                    args,
                    {"gpt_sovits_prompt_text": "segment prompt transcript", "gpt_sovits_prompt_lang": "zh"},
                    get_tts_runner=lambda service: (fake_run_tts, object()),
                    get_audio_duration=lambda path: 4.0,
                    align_audio=lambda *args, **kwargs: False,
                    ffmpeg=object(),
                    librosa=object(),
                    sf=object(),
                )
            finally:
                tts_action_handlers._extract_reference_audio = original_extract

        self.assertTrue(result["success"])
        self.assertEqual(str(fallback_ref_audio), captured["ref_audio_path"])
        self.assertEqual("shared prompt transcript", captured["kwargs"]["gpt_sovits_prompt_text"])

    def test_build_retry_tts_kwargs_uses_high_stability_profile_for_gpt_sovits(self) -> None:
        retry_kwargs = tts_action_handlers._build_retry_tts_kwargs(  # type: ignore[attr-defined]
            {
                "temperature": 1.0,
                "top_p": 1.0,
                "repetition_penalty": 1.1,
                "gpt_sovits_sample_steps": 32,
                "gpt_sovits_batch_threshold": 0.75,
            },
            tts_service_name="gptsovits",
            attempt=1,
            use_fallback_reference=False,
        )

        self.assertEqual(1, retry_kwargs["batch_size"])
        self.assertFalse(retry_kwargs["gpt_sovits_parallel_infer"])
        self.assertFalse(retry_kwargs["gpt_sovits_split_bucket"])
        self.assertEqual("cut0", retry_kwargs["gpt_sovits_text_split_method"])
        self.assertGreaterEqual(retry_kwargs["gpt_sovits_sample_steps"], 38)

    def test_handle_generate_single_tts_uses_two_attempts_for_gpt_sovits_official_fast(self) -> None:
        attempts = {"count": 0}

        def fake_run_tts(text, ref_audio_path, output_audio, language=None, **kwargs):
            attempts["count"] += 1
            if attempts["count"] == 1:
                raise RuntimeError("first pass failed")
            pathlib.Path(output_audio).write_bytes(b"RIFFdemo")
            return True

        with tempfile.TemporaryDirectory() as temp_dir:
            work_dir = pathlib.Path(temp_dir)
            ref_audio = work_dir / "ref.wav"
            ref_audio.write_bytes(b"RIFFref")
            output_audio = work_dir / "segment.wav"
            args = types.SimpleNamespace(
                input="demo.mp4",
                output=str(output_audio),
                text="translated speech",
                start=0.0,
                duration=3.2,
                lang="English",
                tts_service="gptsovits",
                strategy="auto_speedup",
                dub_retry_attempts=0,
                ref_audio=str(ref_audio),
                fallback_ref_audio="",
                fallback_ref_text="",
                nearby_ref_audios="[]",
                qwen_ref_text="",
                gpt_sovits_prompt_text="source prompt transcript",
                gpt_sovits_prompt_lang="zh",
                json=True,
            )

            result, _ = tts_action_handlers.handle_generate_single_tts(
                args,
                {"gpt_sovits_prompt_text": "source prompt transcript", "gpt_sovits_prompt_lang": "zh", "gpt_sovits_official_fast_mode": True},
                get_tts_runner=lambda service: (fake_run_tts, object()),
                get_audio_duration=lambda path: 3.2,
                align_audio=lambda *args, **kwargs: False,
                ffmpeg=object(),
                librosa=object(),
                sf=object(),
            )

        self.assertTrue(result["success"])
        self.assertEqual(2, attempts["count"])

    def test_handle_generate_single_tts_resolves_builtin_gpt_sovits_reference(self) -> None:
        captured = {}

        def fake_run_tts(text, ref_audio_path, output_audio, language=None, **kwargs):
            captured["ref_audio_path"] = ref_audio_path
            captured["kwargs"] = kwargs
            pathlib.Path(output_audio).write_bytes(b"RIFFdemo")
            return True

        with tempfile.TemporaryDirectory() as temp_dir:
            output_audio = pathlib.Path(temp_dir) / "segment.wav"
            args = types.SimpleNamespace(
                input="demo.mp4",
                output=str(output_audio),
                text="translated speech",
                start=0.0,
                duration=3.2,
                lang="English",
                tts_service="gptsovits",
                strategy="auto_speedup",
                dub_retry_attempts=1,
                ref_audio="builtin://gpt-sovits/jing-yuan-cn",
                fallback_ref_audio="",
                fallback_ref_text="",
                nearby_ref_audios="[]",
                qwen_ref_text="",
                gpt_sovits_prompt_text="",
                gpt_sovits_prompt_lang="",
                json=True,
            )

            with patch.object(
                tts_action_handlers,
                "resolve_builtin_gpt_sovits_reference",
                return_value=("H:/VideoSyncMaster/resources/voice_refs/gpt_sovits/jing_yuan_cn.wav", "内置参考文本", "zh"),
            ):
                result, _ = tts_action_handlers.handle_generate_single_tts(
                    args,
                    {"gpt_sovits_prompt_text": "", "gpt_sovits_prompt_lang": ""},
                    get_tts_runner=lambda service: (fake_run_tts, object()),
                    get_audio_duration=lambda path: 3.2,
                    align_audio=lambda *args, **kwargs: False,
                    ffmpeg=object(),
                    librosa=object(),
                    sf=object(),
                )

        self.assertTrue(result["success"])
        self.assertTrue(captured["ref_audio_path"].endswith("jing_yuan_cn.wav"))
        self.assertEqual("内置参考文本", captured["kwargs"]["gpt_sovits_prompt_text"])
        self.assertEqual("zh", captured["kwargs"]["gpt_sovits_prompt_lang"])

    def test_generate_batch_tts_results_uses_hybrid_gpt_sovits_routing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ref_audio = pathlib.Path(temp_dir) / "ref.wav"
            ref_audio.write_bytes(b"RIFFref")
            segments = [
                {"start": 0.0, "end": 1.0, "text": "第一句", "original_index": 0},
                {"start": 1.0, "end": 4.5, "text": "这是一个比较长的句子，用来验证 GPT-SoVITS 微批量是否仍然会被启用。", "original_index": 1},
            ]

            tasks = [
                {
                    "index": 0,
                    "text": "第一句",
                    "ref_audio_path": str(ref_audio),
                    "output_path": str(pathlib.Path(temp_dir) / "segment_0.wav"),
                    "ref_text": "参考文本",
                    "duration": 1.0,
                    "fallback_ref_audio": None,
                    "fallback_ref_text": "",
                    "prefer_single_pass": True,
                },
                {
                    "index": 1,
                    "text": "这是一个比较长的句子，用来验证 GPT-SoVITS 微批量是否仍然会被启用。",
                    "ref_audio_path": str(ref_audio),
                    "output_path": str(pathlib.Path(temp_dir) / "segment_1.wav"),
                    "ref_text": "参考文本",
                    "duration": 3.5,
                    "fallback_ref_audio": None,
                    "fallback_ref_text": "",
                    "prefer_single_pass": False,
                },
            ]

            called_batch = {"value": False, "count": 0}
            called_single = {"count": 0}

            def fake_single_run(text, ref_audio_path, output_audio, language=None, **kwargs):
                called_single["count"] += 1
                pathlib.Path(output_audio).write_bytes(b"RIFFdemo")
                return True

            def fake_batch_run(tasks, language=None, **kwargs):
                called_batch["value"] = True
                called_batch["count"] = len(tasks)
                pathlib.Path(tasks[0]["output_path"]).write_bytes(b"RIFFdemo")
                return iter([{"index": tasks[0]["index"], "success": True, "audio_path": tasks[0]["output_path"], "duration": 3.5}])

            with patch.object(tts_action_handlers, "_build_batch_tts_tasks", return_value=tasks), patch.object(
                tts_action_handlers,
                "prepare_global_reference_audio",
                return_value=(None, False, None),
            ):
                result = tts_action_handlers.generate_batch_tts_results(
                    video_path="demo.mp4",
                    segments=segments,
                    work_dir=temp_dir,
                    target_lang="English",
                    tts_service_name="gptsovits",
                    tts_kwargs={"gpt_sovits_prompt_text": "参考文本", "gpt_sovits_prompt_lang": "zh"},
                    args_ref_audio="builtin://gpt-sovits/jing-yuan-cn",
                    explicit_qwen_ref_text="参考文本",
                    max_retry_attempts=1,
                    get_tts_runner=lambda service: (fake_single_run, fake_batch_run),
                    get_audio_duration=lambda path: 1.0,
                    ffmpeg=object(),
                    librosa=object(),
                    sf=object(),
                )

        self.assertTrue(result["success"])
        self.assertFalse(called_batch["value"])
        self.assertEqual(0, called_batch["count"])
        self.assertEqual(2, called_single["count"])
        self.assertTrue(all(item["success"] for item in result["results"]))

    def test_generate_batch_tts_results_official_fast_mode_routes_all_gpt_sovits_tasks_to_single(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ref_audio = pathlib.Path(temp_dir) / "ref.wav"
            ref_audio.write_bytes(b"RIFFref")
            segments = [
                {"start": 0.0, "end": 1.0, "text": "第一句", "original_index": 0},
                {"start": 1.0, "end": 1.8, "text": "第二句", "original_index": 1},
            ]

            tasks = [
                {
                    "index": 0,
                    "text": "第一句",
                    "ref_audio_path": str(ref_audio),
                    "output_path": str(pathlib.Path(temp_dir) / "segment_0.wav"),
                    "ref_text": "参考文本",
                    "duration": 1.0,
                    "fallback_ref_audio": None,
                    "fallback_ref_text": "",
                    "prefer_single_pass": True,
                },
                {
                    "index": 1,
                    "text": "第二句稍微长一点",
                    "ref_audio_path": str(ref_audio),
                    "output_path": str(pathlib.Path(temp_dir) / "segment_1.wav"),
                    "ref_text": "参考文本",
                    "duration": 2.0,
                    "fallback_ref_audio": None,
                    "fallback_ref_text": "",
                    "prefer_single_pass": False,
                },
            ]

            called_batch = {"count": 0}
            called_single = {"count": 0}

            def fake_single_run(text, ref_audio_path, output_audio, language=None, **kwargs):
                called_single["count"] += 1
                pathlib.Path(output_audio).write_bytes(b"RIFFdemo")
                return True

            def fake_batch_run(tasks, language=None, **kwargs):
                called_batch["count"] = len(tasks)
                for task in tasks:
                    pathlib.Path(task["output_path"]).write_bytes(b"RIFFdemo")
                return iter([{"index": task["index"], "success": True, "audio_path": task["output_path"], "duration": 1.0} for task in tasks])

            with patch.object(tts_action_handlers, "_build_batch_tts_tasks", return_value=tasks), patch.object(
                tts_action_handlers,
                "prepare_global_reference_audio",
                return_value=(None, False, None),
            ):
                result = tts_action_handlers.generate_batch_tts_results(
                    video_path="demo.mp4",
                    segments=segments,
                    work_dir=temp_dir,
                    target_lang="English",
                    tts_service_name="gptsovits",
                    tts_kwargs={"gpt_sovits_prompt_text": "参考文本", "gpt_sovits_prompt_lang": "zh", "gpt_sovits_official_fast_mode": True},
                    args_ref_audio="builtin://gpt-sovits/jing-yuan-cn",
                    explicit_qwen_ref_text="参考文本",
                    max_retry_attempts=3,
                    get_tts_runner=lambda service: (fake_single_run, fake_batch_run),
                    get_audio_duration=lambda path: 1.0,
                    ffmpeg=object(),
                    librosa=object(),
                    sf=object(),
                )

        self.assertTrue(result["success"])
        self.assertEqual(0, called_batch["count"])
        self.assertEqual(2, called_single["count"])
        self.assertTrue(all(item["success"] for item in result["results"]))

    def test_generate_batch_tts_results_gpt_sovits_does_not_require_batch_runner(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ref_audio = pathlib.Path(temp_dir) / "ref.wav"
            ref_audio.write_bytes(b"RIFFref")
            output_audio = pathlib.Path(temp_dir) / "segment_0.wav"
            segments = [
                {"start": 0.0, "end": 1.0, "text": "第一句", "original_index": 0},
            ]
            tasks = [
                {
                    "index": 0,
                    "text": "第一句",
                    "ref_audio_path": str(ref_audio),
                    "output_path": str(output_audio),
                    "ref_text": "参考文本",
                    "duration": 1.0,
                    "fallback_ref_audio": None,
                    "fallback_ref_text": "",
                    "prefer_single_pass": True,
                },
            ]
            called_single = {"count": 0}

            def fake_single_run(text, ref_audio_path, output_audio, language=None, **kwargs):
                called_single["count"] += 1
                pathlib.Path(output_audio).write_bytes(b"RIFFdemo")
                return True

            with patch.object(tts_action_handlers, "_build_batch_tts_tasks", return_value=tasks), patch.object(
                tts_action_handlers,
                "prepare_global_reference_audio",
                return_value=(None, False, None),
            ):
                result = tts_action_handlers.generate_batch_tts_results(
                    video_path="demo.mp4",
                    segments=segments,
                    work_dir=temp_dir,
                    target_lang="English",
                    tts_service_name="gptsovits",
                    tts_kwargs={"gpt_sovits_prompt_text": "参考文本", "gpt_sovits_prompt_lang": "zh"},
                    args_ref_audio="builtin://gpt-sovits/jing-yuan-cn",
                    explicit_qwen_ref_text="参考文本",
                    max_retry_attempts=1,
                    get_tts_runner=lambda service: (fake_single_run, None),
                    get_audio_duration=lambda path: 1.0,
                    ffmpeg=object(),
                    librosa=object(),
                    sf=object(),
                )

        self.assertTrue(result["success"])
        self.assertEqual(1, called_single["count"])
        self.assertTrue(result["results"][0]["success"])


if __name__ == "__main__":
    unittest.main()
