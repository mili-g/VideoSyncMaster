import pathlib
import sys
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from vsm.app.services import ExecutionServices


class ExecutionServicesTests(unittest.TestCase):
    def test_execution_services_exposes_router_required_attributes(self) -> None:
        noop = lambda *args, **kwargs: None
        services = ExecutionServices(
            dispatch_basic_action=noop,
            list_basic_actions=lambda: ["test_asr"],
            get_tts_runner=noop,
            run_asr=noop,
            translate_text=noop,
            align_audio=noop,
            get_audio_duration=noop,
            merge_audios_to_video=noop,
            analyze_video=noop,
            transcode_video=noop,
            dub_video=noop,
            handle_generate_single_tts=noop,
            handle_generate_batch_tts=noop,
            handle_prepare_reference_audio=noop,
            ffmpeg=object(),
            librosa=object(),
            sf=object(),
            warmup_tts_runtime=noop,
            switch_runtime_profile=noop,
        )

        self.assertEqual(noop, services.dispatch_basic_action)
        self.assertEqual(["test_asr"], services.list_basic_actions())
        self.assertEqual(noop, services.run_asr)
        self.assertTrue(callable(services.handle_generate_batch_tts))
        self.assertTrue(callable(services.warmup_tts_runtime))
        self.assertTrue(callable(services.switch_runtime_profile))


if __name__ == "__main__":
    unittest.main()
