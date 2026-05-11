import pathlib
import sys
import tempfile
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from vsm.app.workflows.tts_reference_workflow import build_batch_tts_tasks, resolve_reference_transcript


class _FakeStream:
    def output(self, *_args, **_kwargs):
        return self


class _FakeFfmpeg:
    def input(self, *_args, **_kwargs):
        return _FakeStream()


class _FakeLibrosaEffects:
    @staticmethod
    def trim(y, top_db=20):
        return y, (0, len(y))


class _FakeLibrosa:
    effects = _FakeLibrosaEffects()

    @staticmethod
    def load(_path, sr=None):
        return [0.1] * 48000, 24000 if sr is None else sr


class _FakeSf:
    @staticmethod
    def write(path, data, sr):
        with open(path, "wb") as handle:
            handle.write(b"wav")


class TtsReferenceWorkflowTests(unittest.TestCase):
    def test_resolve_reference_transcript_prefers_source_text(self):
        segment = {
            "text": "译文",
            "source_text": "source transcript",
            "original_text": "original transcript",
        }

        self.assertEqual("source transcript", resolve_reference_transcript(segment))

    def test_build_batch_tts_tasks_uses_matching_transcript_for_segment_reference_audio(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            work_dir = pathlib.Path(temp_dir)

            def fake_run_ffmpeg(_stream, overwrite_output=True):
                raw_dir = work_dir / ".cache" / "raw"
                raw_dir.mkdir(parents=True, exist_ok=True)
                raw_file = raw_dir / "ref_raw_0_0.0.wav"
                raw_file.write_bytes(b"wav")

            import vsm.app.workflows.tts_reference_workflow as workflow

            original_run_ffmpeg = workflow.run_ffmpeg
            workflow.run_ffmpeg = fake_run_ffmpeg
            try:
                tasks = build_batch_tts_tasks(
                    video_path="demo.mp4",
                    segments=[
                        {
                            "start": 0.0,
                            "end": 2.0,
                            "text": "让你始终是项目的设计师",
                            "source_text": "and to keep you as the architect of your projects",
                            "original_index": 13,
                        }
                    ],
                    work_dir=str(work_dir),
                    args_ref_audio="",
                    voice_mode="clone",
                    official_fast_mode=False,
                    explicit_qwen_ref_text="",
                    shared_ref_path=str(work_dir / "global_ref_seed_ref.wav"),
                    shared_ref_meta={"text": "那么，如何才能构建完整的项目呢？"},
                    tts_service_name="gptsovits",
                    ffmpeg=_FakeFfmpeg(),
                    librosa=_FakeLibrosa(),
                    sf=_FakeSf(),
                    get_audio_duration=lambda _path: 2.0,
                    log_prefix="[Test]",
                )
            finally:
                workflow.run_ffmpeg = original_run_ffmpeg

            self.assertEqual(1, len(tasks))
            self.assertEqual(
                "and to keep you as the architect of your projects",
                tasks[0]["ref_text"],
            )
            self.assertEqual("那么，如何才能构建完整的项目呢？", tasks[0]["fallback_ref_text"])

    def test_build_batch_tts_tasks_keeps_raw_reference_when_trimmed_gptsovits_audio_is_too_short(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            work_dir = pathlib.Path(temp_dir)

            def fake_run_ffmpeg(_stream, overwrite_output=True):
                raw_dir = work_dir / ".cache" / "raw"
                raw_dir.mkdir(parents=True, exist_ok=True)
                raw_file = raw_dir / "ref_raw_0_0.0.wav"
                raw_file.write_bytes(b"raw-wav")

            class _ShortTrimLibrosaEffects:
                @staticmethod
                def trim(y, top_db=20):
                    return y[:24000], (0, 24000)

            class _ShortTrimLibrosa:
                effects = _ShortTrimLibrosaEffects()

                @staticmethod
                def load(_path, sr=None):
                    return [0.1] * 72000, 24000 if sr is None else sr

            import vsm.app.workflows.tts_reference_workflow as workflow

            original_run_ffmpeg = workflow.run_ffmpeg
            workflow.run_ffmpeg = fake_run_ffmpeg
            try:
                tasks = build_batch_tts_tasks(
                    video_path="demo.mp4",
                    segments=[
                        {
                            "start": 0.0,
                            "end": 1.2,
                            "text": "短句",
                            "source_text": "short source sentence",
                            "original_index": 0,
                        }
                    ],
                    work_dir=str(work_dir),
                    args_ref_audio="",
                    voice_mode="clone",
                    official_fast_mode=False,
                    explicit_qwen_ref_text="",
                    shared_ref_path="",
                    shared_ref_meta=None,
                    tts_service_name="gptsovits",
                    ffmpeg=_FakeFfmpeg(),
                    librosa=_ShortTrimLibrosa(),
                    sf=_FakeSf(),
                    get_audio_duration=lambda _path: 3.0,
                    log_prefix="[Test]",
                )
            finally:
                workflow.run_ffmpeg = original_run_ffmpeg

            self.assertEqual(1, len(tasks))
            ref_path = pathlib.Path(tasks[0]["ref_audio_path"])
            self.assertEqual(b"raw-wav", ref_path.read_bytes())

    def test_build_batch_tts_tasks_uses_shared_reference_as_primary_for_gpt_sovits_clone_mode(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            work_dir = pathlib.Path(temp_dir)
            shared_ref = work_dir / "gpt_sovits_shared_ref.wav"
            shared_ref.write_bytes(b"shared")

            tasks = build_batch_tts_tasks(
                video_path="demo.mp4",
                segments=[
                    {
                        "start": 0.0,
                        "end": 1.1,
                        "text": "短句一",
                        "source_text": "source line one",
                        "original_index": 0,
                    },
                    {
                        "start": 1.2,
                        "end": 2.0,
                        "text": "短句二",
                        "source_text": "source line two",
                        "original_index": 1,
                    },
                ],
                work_dir=str(work_dir),
                args_ref_audio="",
                voice_mode="clone",
                official_fast_mode=False,
                explicit_qwen_ref_text="",
                shared_ref_path=str(shared_ref),
                shared_ref_meta={"text": "shared prompt transcript"},
                tts_service_name="gptsovits",
                ffmpeg=_FakeFfmpeg(),
                librosa=_FakeLibrosa(),
                sf=_FakeSf(),
                get_audio_duration=lambda _path: 4.2,
                log_prefix="[Test]",
            )

            self.assertEqual(2, len(tasks))
            self.assertTrue(all(task["ref_audio_path"] == str(shared_ref) for task in tasks))
            self.assertTrue(all(task["ref_text"] == "shared prompt transcript" for task in tasks))
            self.assertTrue(all(task["prefer_single_pass"] for task in tasks))
            self.assertTrue(all(not task["skip_segment_retry"] for task in tasks))

    def test_build_batch_tts_tasks_keeps_single_pass_preference_for_short_gpt_sovits_segments_in_official_fast_mode(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            work_dir = pathlib.Path(temp_dir)
            shared_ref = work_dir / "gpt_sovits_shared_ref.wav"
            shared_ref.write_bytes(b"shared")

            tasks = build_batch_tts_tasks(
                video_path="demo.mp4",
                segments=[
                    {
                        "start": 0.0,
                        "end": 0.9,
                        "text": "短句一",
                        "source_text": "source line one",
                        "original_index": 0,
                    },
                    {
                        "start": 1.0,
                        "end": 1.8,
                        "text": "短句二",
                        "source_text": "source line two",
                        "original_index": 1,
                    },
                ],
                work_dir=str(work_dir),
                args_ref_audio="",
                voice_mode="clone",
                official_fast_mode=True,
                explicit_qwen_ref_text="",
                shared_ref_path=str(shared_ref),
                shared_ref_meta={"text": "shared prompt transcript"},
                tts_service_name="gptsovits",
                ffmpeg=_FakeFfmpeg(),
                librosa=_FakeLibrosa(),
                sf=_FakeSf(),
                get_audio_duration=lambda _path: 4.2,
                log_prefix="[Test]",
            )

            self.assertEqual(2, len(tasks))
            self.assertTrue(all(task["prefer_single_pass"] for task in tasks))


if __name__ == "__main__":
    unittest.main()
