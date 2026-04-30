import pathlib
import sys
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from vsm.app.workflows.action_router import ActionRouter, WorkflowCommand, WorkflowExecutionContext


class ActionRouterTests(unittest.TestCase):
    def test_dispatches_registered_command(self) -> None:
        router = ActionRouter(
            pre_dispatch=lambda: (False, None),
            commands=[WorkflowCommand(name="ping", handler=lambda: {"ok": True})],
            known_actions=["pong"],
        )

        result = router.dispatch(WorkflowExecutionContext(action="ping", args=None))

        self.assertEqual({"ok": True}, result)
        self.assertTrue(router.has_command("ping"))
        self.assertTrue(router.has_command("pong"))
        self.assertEqual(["ping", "pong"], router.list_commands())

    def test_pre_dispatch_short_circuits_command_execution(self) -> None:
        router = ActionRouter(
            pre_dispatch=lambda: (True, {"source": "legacy"}),
            commands={"ping": lambda: {"ok": True}},
        )

        result = router.dispatch(WorkflowExecutionContext(action="ping", args=None))

        self.assertEqual({"source": "legacy"}, result)


if __name__ == "__main__":
    unittest.main()
