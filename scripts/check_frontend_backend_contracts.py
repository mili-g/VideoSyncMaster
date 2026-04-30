from __future__ import annotations

import json
import pathlib
import re
import sys


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
GENERATED_CATALOG_PATH = ROOT_DIR / "apps" / "desktop" / "ui" / "src" / "types" / "backendCommandCatalog.generated.json"
BACKEND_TYPES_PATH = ROOT_DIR / "apps" / "desktop" / "ui" / "src" / "types" / "backend.ts"


def load_catalog_command_names() -> list[str]:
    payload = json.loads(GENERATED_CATALOG_PATH.read_text(encoding="utf-8"))
    return sorted(command["name"] for command in payload["commands"])


def parse_response_map_keys() -> list[str]:
    content = BACKEND_TYPES_PATH.read_text(encoding="utf-8")
    match = re.search(r"export type BackendCommandResponseMap = \{(?P<body>.*?)\n\};", content, re.S)
    if not match:
        raise RuntimeError("Unable to locate BackendCommandResponseMap in backend.ts")
    keys = re.findall(r"^\s*([a-z0-9_]+)\s*:", match.group("body"), re.M)
    return sorted(keys)


def main() -> int:
    if not GENERATED_CATALOG_PATH.exists():
        print(f"Missing generated catalog: {GENERATED_CATALOG_PATH}")
        return 1

    catalog_names = load_catalog_command_names()
    response_map_keys = parse_response_map_keys()

    missing_in_response_map = sorted(set(catalog_names) - set(response_map_keys))
    extra_in_response_map = sorted(set(response_map_keys) - set(catalog_names))

    if missing_in_response_map or extra_in_response_map:
        if missing_in_response_map:
            print("Missing response map entries:", ", ".join(missing_in_response_map))
        if extra_in_response_map:
            print("Unexpected response map entries:", ", ".join(extra_in_response_map))
        return 1

    print("Frontend backend response map matches generated backend command catalog.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
