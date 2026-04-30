import pathlib
import sys
import unittest
from types import SimpleNamespace


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from vsm.app.workflows.basic_actions_workflow import build_basic_action_handlers, dispatch_basic_action, list_basic_actions


class BasicActionsWorkflowTests(unittest.TestCase):
    def test_build_basic_action_handlers_registers_expected_commands(self) -> None:
        args = SimpleNamespace(
            action="translate_text",
            input="hello",
            lang="Chinese",
            json=True,
        )
        handlers = build_basic_action_handlers(
            args,
            asr_kwargs={},
            tts_kwargs={},
            extra_kwargs={},
            get_tts_runner=lambda *args, **kwargs: (None, None),
            run_asr=lambda *args, **kwargs: [],
            translate_text=lambda *args, **kwargs: "nihao",
            align_audio=lambda *args, **kwargs: True,
            get_audio_duration=lambda *args, **kwargs: 0.0,
            merge_audios_to_video=lambda *args, **kwargs: True,
            analyze_video=lambda *args, **kwargs: {},
            transcode_video=lambda *args, **kwargs: {},
            dub_video=lambda *args, **kwargs: {},
        )

        self.assertEqual(
            {
                "analyze_video",
                "check_audio_files",
                "dub_video",
                "merge_video",
                "test_align",
                "test_asr",
                "test_tts",
                "transcode_video",
                "translate_text",
            },
            set(handlers.keys()),
        )

    def test_dispatch_basic_action_executes_registered_handler(self) -> None:
        args = SimpleNamespace(
            action="translate_text",
            input="hello",
            lang="Chinese",
            json=True,
        )

        handled, result = dispatch_basic_action(
            args,
            asr_kwargs={},
            tts_kwargs={},
            extra_kwargs={},
            get_tts_runner=lambda *args, **kwargs: (None, None),
            run_asr=lambda *args, **kwargs: [],
            translate_text=lambda text, target, **kwargs: f"{text}->{target}",
            align_audio=lambda *args, **kwargs: True,
            get_audio_duration=lambda *args, **kwargs: 0.0,
            merge_audios_to_video=lambda *args, **kwargs: True,
            analyze_video=lambda *args, **kwargs: {},
            transcode_video=lambda *args, **kwargs: {},
            dub_video=lambda *args, **kwargs: {},
        )

        self.assertTrue(handled)
        self.assertEqual({"success": True, "text": "hello->Chinese"}, result)

    def test_dispatch_basic_action_returns_false_for_unknown_action(self) -> None:
        args = SimpleNamespace(action="unknown")

        handled, result = dispatch_basic_action(
            args,
            asr_kwargs={},
            tts_kwargs={},
            extra_kwargs={},
            get_tts_runner=lambda *args, **kwargs: (None, None),
            run_asr=lambda *args, **kwargs: [],
            translate_text=lambda *args, **kwargs: "",
            align_audio=lambda *args, **kwargs: True,
            get_audio_duration=lambda *args, **kwargs: 0.0,
            merge_audios_to_video=lambda *args, **kwargs: True,
            analyze_video=lambda *args, **kwargs: {},
            transcode_video=lambda *args, **kwargs: {},
            dub_video=lambda *args, **kwargs: {},
        )

        self.assertFalse(handled)
        self.assertIsNone(result)

    def test_list_basic_actions_returns_supported_names(self) -> None:
        self.assertIn("translate_text", list_basic_actions())
        self.assertIn("merge_video", list_basic_actions())


if __name__ == "__main__":
    unittest.main()
