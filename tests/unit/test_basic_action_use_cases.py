import json
import pathlib
import sys
import tempfile
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from vsm.app.use_cases import (
    check_audio_files_use_case,
    dub_video_use_case,
    merge_video_use_case,
    prepare_merge_video_segments,
    test_tts_use_case,
    translate_text_use_case,
)


class BasicActionUseCasesTests(unittest.TestCase):
    def test_translate_text_use_case_normalizes_string_result(self) -> None:
        result = translate_text_use_case(
            "hello",
            target_lang="Chinese",
            extra_kwargs={"provider": "mock"},
            translate_text=lambda text, target, **kwargs: f"{text}->{target}",
        )

        self.assertEqual({"success": True, "text": "hello->Chinese"}, result)

    def test_test_tts_use_case_returns_output_contract(self) -> None:
        result = test_tts_use_case(
            "hello",
            output_path="out.wav",
            language="English",
            ref_audio=None,
            runtime_kwargs={"speaker": "demo"},
            run_tts_func=lambda *args, **kwargs: True,
        )

        self.assertEqual({"success": True, "output": "out.wav"}, result)

    def test_prepare_merge_video_segments_aligns_overlong_audio(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            audio_path = pathlib.Path(temp_dir) / "segment.wav"
            audio_path.write_bytes(b"wave")
            json_path = pathlib.Path(temp_dir) / "segments.json"
            json_path.write_text(
                json.dumps([{"start": 0.0, "end": 1.0, "path": str(audio_path)}]),
                encoding="utf-8",
            )

            prepared = prepare_merge_video_segments(
                str(json_path),
                strategy="audio_align",
                align_audio=lambda src, dest, duration: True,
                get_audio_duration=lambda path: 1.5,
            )

            self.assertEqual(1.0, prepared.segments[0]["duration"])
            self.assertTrue(prepared.segments[0]["path"].endswith("_aligned.wav"))
            self.assertEqual(1, len(prepared.messages))

    def test_merge_video_use_case_returns_messages(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            audio_path = pathlib.Path(temp_dir) / "segment.wav"
            audio_path.write_bytes(b"wave")
            json_path = pathlib.Path(temp_dir) / "segments.json"
            json_path.write_text(
                json.dumps([{"start": 0.0, "end": 1.0, "path": str(audio_path)}]),
                encoding="utf-8",
            )

            result = merge_video_use_case(
                "input.mp4",
                json_path=str(json_path),
                output_path="output.mp4",
                strategy="freeze_frame",
                audio_mix_mode="replace_original",
                align_audio=lambda src, dest, duration: True,
                get_audio_duration=lambda path: 1.5,
                merge_audios_to_video=lambda *args, **kwargs: True,
            )

            self.assertTrue(result["success"])
            self.assertEqual("output.mp4", result["output"])
            self.assertEqual(1, len(result["messages"]))
            self.assertEqual([{"start": 0.0, "end": 1.0, "path": str(audio_path), "duration": 1.0}], result["segments"])

    def test_merge_video_use_case_normalizes_legacy_strategy_and_mix_mode(self) -> None:
        merge_calls = []
        with tempfile.TemporaryDirectory() as temp_dir:
            audio_path = pathlib.Path(temp_dir) / "segment.wav"
            audio_path.write_bytes(b"wave")
            json_path = pathlib.Path(temp_dir) / "segments.json"
            json_path.write_text(
                json.dumps([{"start": 0.0, "end": 1.0, "path": str(audio_path)}]),
                encoding="utf-8",
            )

            result = merge_video_use_case(
                "input.mp4",
                json_path=str(json_path),
                output_path="output.mp4",
                strategy="stretch",
                audio_mix_mode="replace",
                align_audio=lambda src, dest, duration: True,
                get_audio_duration=lambda path: 1.0,
                merge_audios_to_video=lambda *args, **kwargs: merge_calls.append((args, kwargs)) or True,
            )

            self.assertTrue(result["success"])
            self.assertEqual("auto_speedup", merge_calls[0][1]["strategy"])
            self.assertEqual("replace_original", merge_calls[0][1]["audio_mix_mode"])

    def test_merge_video_use_case_returns_updated_timeline_from_backend_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            audio_path = pathlib.Path(temp_dir) / "segment.wav"
            audio_path.write_bytes(b"wave")
            json_path = pathlib.Path(temp_dir) / "segments.json"
            json_path.write_text(
                json.dumps([{"start": 0.0, "end": 1.0, "path": str(audio_path), "original_index": 0}]),
                encoding="utf-8",
            )

            def fake_merge(_video_path, segments, _output_path, **_kwargs):
                segments[0]["timeline_start"] = 0.25
                segments[0]["timeline_duration"] = 1.75
                return True

            result = merge_video_use_case(
                "input.mp4",
                json_path=str(json_path),
                output_path="output.mp4",
                strategy="rife",
                audio_mix_mode="preserve_background",
                align_audio=lambda src, dest, duration: True,
                get_audio_duration=lambda path: 1.0,
                merge_audios_to_video=fake_merge,
            )

            self.assertTrue(result["success"])
            self.assertEqual(0.25, result["segments"][0]["timeline_start"])
            self.assertEqual(1.75, result["segments"][0]["timeline_duration"])

    def test_merge_video_use_case_preserves_subtitle_timeline_behavior_for_all_merge_strategies(self) -> None:
        strategies_with_expected_timeline = {
            "auto_speedup": None,
            "frame_blend": (0.1, 1.4),
            "freeze_frame": (0.2, 1.5),
            "rife": (0.3, 1.6),
        }

        for strategy, expected_timeline in strategies_with_expected_timeline.items():
            with self.subTest(strategy=strategy):
                with tempfile.TemporaryDirectory() as temp_dir:
                    audio_path = pathlib.Path(temp_dir) / "segment.wav"
                    audio_path.write_bytes(b"wave")
                    json_path = pathlib.Path(temp_dir) / "segments.json"
                    json_path.write_text(
                        json.dumps([{"start": 0.0, "end": 1.0, "path": str(audio_path), "original_index": 0}]),
                        encoding="utf-8",
                    )

                    def fake_merge(_video_path, segments, _output_path, **_kwargs):
                        if expected_timeline is not None:
                            segments[0]["timeline_start"] = expected_timeline[0]
                            segments[0]["timeline_duration"] = expected_timeline[1]
                        return True

                    result = merge_video_use_case(
                        "input.mp4",
                        json_path=str(json_path),
                        output_path="output.mp4",
                        strategy=strategy,
                        audio_mix_mode="preserve_background",
                        align_audio=lambda src, dest, duration: True,
                        get_audio_duration=lambda path: 1.0,
                        merge_audios_to_video=fake_merge,
                    )

                    self.assertTrue(result["success"])
                    if expected_timeline is None:
                        self.assertNotIn("timeline_start", result["segments"][0])
                        self.assertNotIn("timeline_duration", result["segments"][0])
                    else:
                        self.assertEqual(expected_timeline[0], result["segments"][0]["timeline_start"])
                        self.assertEqual(expected_timeline[1], result["segments"][0]["timeline_duration"])

    def test_check_audio_files_use_case_marks_missing_file(self) -> None:
        result = check_audio_files_use_case(
            '["missing.wav"]',
            get_audio_duration=lambda path: 0.0,
        )

        self.assertEqual({"success": True, "durations": {"missing.wav": -1.0}}, result)

    def test_dub_video_use_case_merges_runtime_kwargs(self) -> None:
        captured = {}

        def fake_dub_video(input_path, target_lang, output_path, **kwargs):
            captured["input_path"] = input_path
            captured["target_lang"] = target_lang
            captured["output_path"] = output_path
            captured["kwargs"] = kwargs
            return {"success": True}

        result = dub_video_use_case(
            "video.mp4",
            target_lang="Chinese",
            output_path="dubbed.mp4",
            work_dir="work",
            asr_service="faster-whisper",
            vad_onset=0.7,
            vad_offset=0.7,
            tts_service="indextts",
            strategy="stretch",
            audio_mix_mode="mix",
            ori_lang="en",
            dub_retry_attempts=2,
            asr_kwargs={"beam_size": 5},
            tts_kwargs={"speaker": "demo"},
            extra_kwargs={"provider": "mock"},
            dub_video=fake_dub_video,
        )

        self.assertEqual({"success": True}, result)
        self.assertEqual("video.mp4", captured["input_path"])
        self.assertEqual("Chinese", captured["target_lang"])
        self.assertEqual(5, captured["kwargs"]["beam_size"])
        self.assertEqual("demo", captured["kwargs"]["speaker"])
        self.assertEqual("mock", captured["kwargs"]["provider"])
        self.assertEqual("auto_speedup", captured["kwargs"]["strategy"])
        self.assertEqual("preserve_background", captured["kwargs"]["audio_mix_mode"])


if __name__ == "__main__":
    unittest.main()
