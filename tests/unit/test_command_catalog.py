import pathlib
import sys
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from vsm.app.contracts import (
    build_backend_command_catalog,
    describe_backend_commands,
    get_backend_command_names,
    serialize_backend_command_catalog,
)


class CommandCatalogTests(unittest.TestCase):
    def test_command_catalog_names_are_unique_and_sorted(self) -> None:
        names = get_backend_command_names()

        self.assertEqual(sorted(names), names)
        self.assertEqual(len(names), len(set(names)))
        self.assertIn("translate_text", names)
        self.assertIn("generate_batch_tts", names)

    def test_command_descriptions_include_required_args(self) -> None:
        descriptions = describe_backend_commands()

        self.assertTrue(any("required: input, lang" in item for item in descriptions))
        self.assertTrue(any(item.startswith("merge_video") for item in descriptions))

    def test_catalog_entries_expose_required_args(self) -> None:
        catalog = {command.name: command for command in build_backend_command_catalog()}

        self.assertEqual(["input", "output", "text", "duration"], catalog["generate_single_tts"].required_args())
        self.assertEqual("runtime", catalog["warmup_tts_runtime"].category)

    def test_serialized_catalog_payload_contains_args(self) -> None:
        payload = serialize_backend_command_catalog()

        translate_command = next(item for item in payload if item["name"] == "translate_text")
        self.assertEqual("translation", translate_command["category"])
        self.assertEqual("input", translate_command["args"][0]["name"])


if __name__ == "__main__":
    unittest.main()
