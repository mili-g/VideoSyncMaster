import logging
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

import vsm.app.workflows.dub_video_workflow as dub_video_workflow


class _FakeTranslationConfig:
    def __init__(self) -> None:
        self.kwargs = {"api_key": "k", "base_url": "u", "model": "m"}

    def to_translator_kwargs(self):
        return dict(self.kwargs)


class _FakeAsrConfig:
    def to_runner_kwargs(self):
        return {"beam_size": 5}


class _FakeTtsConfig:
    ref_audio = "ref.wav"
    qwen_ref_text = "ref text"
    gpt_sovits_prompt_text = ""

    def to_runner_kwargs(self):
        return {"speaker": "demo"}


class _FakeConfig:
    def __init__(self, root_dir: str) -> None:
        self.input_path = "input.mp4"
        self.target_lang = "German"
        self.output_path = "output.mp4"
        self.asr_service = "qwen"
        self.vad_onset = 0.7
        self.vad_offset = 0.7
        self.ori_lang = "zh"
        self.translation = _FakeTranslationConfig()
        self.asr = _FakeAsrConfig()
        self.tts = _FakeTtsConfig()
        self.tts_service = "indextts"
        self.work_dir = root_dir
        self.output_dir_root = root_dir
        self.basename = "demo"
        self.strategy = "stretch"
        self.audio_mix_mode = "replace"
        self.dub_retry_attempts = 2


class _FakeTranslator:
    def __init__(self) -> None:
        self.calls = []

    def translate(self, text, target_lang):
        self.calls.append((text, target_lang))
        return f"{text}-{target_lang}"


class DubVideoWorkflowTests(unittest.TestCase):
    def test_run_dub_video_workflow_passes_runtime_data_end_to_end(self) -> None:
        log_events = []
        stage_events = []
        progress_events = []
        partial_events = []
        translator_cleanup = []
        translator_kwargs_seen = {}
        asr_calls = []
        tts_runner_calls = []
        merge_calls = []
        batch_calls = []

        with tempfile.TemporaryDirectory() as temp_dir:
            config = _FakeConfig(temp_dir)

            def translator_factory(**kwargs):
                translator_kwargs_seen.update(kwargs)
                return _FakeTranslator()

            def run_asr(input_path, **kwargs):
                asr_calls.append((input_path, kwargs))
                return [
                    {"text": "你好", "start": 0.0, "end": 1.0},
                    {"text": "世界", "start": 1.0, "end": 2.0},
                ]

            def get_tts_runner(service):
                tts_runner_calls.append(service)
                return (lambda *args, **kwargs: True, object())

            def merge_audios_to_video(input_path, segments, output_path, **kwargs):
                merge_calls.append((input_path, segments, output_path, kwargs))
                return True

            def fake_generate_batch_tts_results(**kwargs):
                batch_calls.append(kwargs)
                results = []
                for index, segment in enumerate(kwargs["segments"]):
                    audio_path = segment["audioPath"]
                    pathlib.Path(audio_path).write_bytes(b"RIFFdemo")
                    results.append(
                        {
                            "index": index,
                            "success": True,
                            "audio_path": audio_path,
                        }
                    )
                return {"success": True, "results": results}

            with patch.object(dub_video_workflow, "build_dub_video_runtime_config", return_value=config), patch.object(
                dub_video_workflow,
                "generate_batch_tts_results",
                side_effect=fake_generate_batch_tts_results,
            ):
                result = dub_video_workflow.run_dub_video_workflow(
                    input_path="input.mp4",
                    target_lang="German",
                    output_path="output.mp4",
                    asr_service="qwen",
                    vad_onset=0.7,
                    vad_offset=0.7,
                    tts_service="indextts",
                    kwargs={"source": "test"},
                    logger=object(),
                    logging=logging,
                    log_business=lambda *args, **kwargs: log_events.append((args, kwargs)),
                    emit_stage=lambda *args, **kwargs: stage_events.append((args, kwargs)),
                    emit_progress=lambda *args, **kwargs: progress_events.append((args, kwargs)),
                    emit_partial_result=lambda *args, **kwargs: partial_events.append((args, kwargs)),
                    translator_factory=translator_factory,
                    cleanup_translator=lambda translator: translator_cleanup.append(translator),
                    get_tts_runner=get_tts_runner,
                    run_asr=run_asr,
                    get_audio_duration=lambda path: 0.5,
                    align_audio=lambda *args, **kwargs: False,
                    merge_audios_to_video=merge_audios_to_video,
                    ffmpeg=object(),
                    librosa=object(),
                    sf=object(),
                )

        self.assertTrue(result["success"])
        self.assertEqual("output.mp4", result["output"])
        self.assertEqual({"api_key": "k", "base_url": "u", "model": "m"}, translator_kwargs_seen)
        self.assertEqual(1, len(translator_cleanup))
        self.assertEqual(1, len(asr_calls))
        self.assertEqual("input.mp4", asr_calls[0][0])
        self.assertEqual("qwen", asr_calls[0][1]["service"])
        self.assertTrue(str(asr_calls[0][1]["output_dir"]).endswith(".cache"))
        self.assertEqual(0.7, asr_calls[0][1]["vad_onset"])
        self.assertEqual(0.7, asr_calls[0][1]["vad_offset"])
        self.assertEqual("zh", asr_calls[0][1]["language"])
        self.assertEqual({"api_key": "k", "base_url": "u", "model": "m"}, asr_calls[0][1]["splitter_kwargs"])
        self.assertEqual(5, asr_calls[0][1]["beam_size"])
        self.assertEqual(["indextts"], tts_runner_calls)
        self.assertEqual(1, len(batch_calls))
        self.assertEqual("German", batch_calls[0]["target_lang"])
        self.assertEqual("indextts", batch_calls[0]["tts_service_name"])
        self.assertEqual({"speaker": "demo"}, batch_calls[0]["tts_kwargs"])
        self.assertEqual("ref text", batch_calls[0]["explicit_qwen_ref_text"])
        self.assertEqual(1, len(merge_calls))
        self.assertEqual("input.mp4", merge_calls[0][0])
        self.assertEqual("output.mp4", merge_calls[0][2])
        self.assertEqual("replace", merge_calls[0][3]["audio_mix_mode"])
        self.assertEqual("stretch", merge_calls[0][3]["strategy"])
        self.assertGreaterEqual(len(progress_events), 2)
        self.assertGreaterEqual(len(partial_events), 2)

    def test_run_dub_video_workflow_passes_gpt_sovits_prompt_text_as_explicit_reference_text(self) -> None:
        batch_calls = []

        with tempfile.TemporaryDirectory() as temp_dir:
            config = _FakeConfig(temp_dir)
            config.tts_service = "gptsovits"
            config.tts.qwen_ref_text = ""
            config.tts.gpt_sovits_prompt_text = "shared prompt transcript"

            def fake_generate_batch_tts_results(**kwargs):
                batch_calls.append(kwargs)
                audio_path = pathlib.Path(temp_dir) / "segment_0.wav"
                audio_path.write_bytes(b"RIFFdemo")
                return {
                    "success": True,
                    "results": [
                        {
                            "index": 0,
                            "success": True,
                            "audio_path": str(audio_path),
                            "duration": 0.5,
                        }
                    ],
                }

            with patch.object(dub_video_workflow, "build_dub_video_runtime_config", return_value=config), patch.object(
                dub_video_workflow,
                "generate_batch_tts_results",
                side_effect=fake_generate_batch_tts_results,
            ):
                result = dub_video_workflow.run_dub_video_workflow(
                    input_path="input.mp4",
                    target_lang="German",
                    output_path="output.mp4",
                    asr_service="qwen",
                    vad_onset=0.7,
                    vad_offset=0.7,
                    tts_service="gptsovits",
                    kwargs={"source": "test"},
                    logger=object(),
                    logging=logging,
                    log_business=lambda *args, **kwargs: None,
                    emit_stage=lambda *args, **kwargs: None,
                    emit_progress=lambda *args, **kwargs: None,
                    emit_partial_result=lambda *args, **kwargs: None,
                    translator_factory=lambda **kwargs: _FakeTranslator(),
                    cleanup_translator=lambda translator: None,
                    get_tts_runner=lambda service: (lambda *args, **kwargs: True, object()),
                    run_asr=lambda input_path, **kwargs: [{"text": "你好", "start": 0.0, "end": 1.0}],
                    get_audio_duration=lambda path: 0.5,
                    align_audio=lambda *args, **kwargs: False,
                    merge_audios_to_video=lambda *args, **kwargs: True,
                    ffmpeg=object(),
                    librosa=object(),
                    sf=object(),
                )

        self.assertTrue(result["success"])
        self.assertEqual(1, len(batch_calls))
        self.assertEqual("shared prompt transcript", batch_calls[0]["explicit_qwen_ref_text"])


if __name__ == "__main__":
    unittest.main()
