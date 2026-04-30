import pathlib
import sys
import unittest
from types import SimpleNamespace


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from bootstrap.action_router_factory import build_action_router
from vsm.app.services import ExecutionServices
from vsm.app.workflows.action_router import WorkflowExecutionContext


class ActionRouterFactoryTests(unittest.TestCase):
    def test_build_action_router_uses_execution_services_dependencies(self) -> None:
        calls: list[str] = []

        def dispatch_basic_action(*args, **kwargs):
            calls.append("dispatch_basic_action")
            return False, None

        services = ExecutionServices(
            dispatch_basic_action=dispatch_basic_action,
            list_basic_actions=lambda: ["translate_text", "test_asr"],
            get_tts_runner=lambda *args, **kwargs: (lambda *a, **k: True, None),
            run_asr=lambda *args, **kwargs: [],
            translate_text=lambda *args, **kwargs: {},
            align_audio=lambda *args, **kwargs: True,
            get_audio_duration=lambda *args, **kwargs: 0.0,
            merge_audios_to_video=lambda *args, **kwargs: True,
            analyze_video=lambda *args, **kwargs: {},
            transcode_video=lambda *args, **kwargs: {},
            dub_video=lambda *args, **kwargs: {},
            handle_generate_single_tts=lambda *args, **kwargs: ({"success": True}, None),
            handle_generate_batch_tts=lambda *args, **kwargs: {"success": True},
            handle_prepare_reference_audio=lambda *args, **kwargs: ({"success": True}, None),
            ffmpeg=object(),
            librosa=object(),
            sf=object(),
            warmup_tts_runtime=lambda *args, **kwargs: {"success": True},
            switch_runtime_profile=lambda *args, **kwargs: {"success": True},
        )
        args = SimpleNamespace(action="warmup_tts_runtime", tts_service="indextts", tts_model_profile="base")

        router = build_action_router(
            args=args,
            asr_kwargs={},
            tts_kwargs={},
            extra_kwargs={},
            services=services,
        )
        result = router.dispatch(WorkflowExecutionContext(action="warmup_tts_runtime", args=args))

        self.assertEqual({"success": True}, result)
        self.assertEqual(["dispatch_basic_action"], calls)
        self.assertTrue(router.has_command("generate_single_tts"))
        self.assertTrue(router.has_command("warmup_tts_runtime"))
        self.assertTrue(router.has_command("switch_runtime_profile"))
        self.assertTrue(router.has_command("translate_text"))
        self.assertTrue(router.has_command("prepare_reference_audio"))


if __name__ == "__main__":
    unittest.main()
