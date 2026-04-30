from __future__ import annotations

import json
from typing import Any, Callable


def emit_json_block(result_data: Any, write_line: Callable[[str], None]) -> None:
    write_line("\n__JSON_START__\n")
    write_line(json.dumps(result_data, indent=None, ensure_ascii=False))
    write_line("\n__JSON_END__\n")

