from __future__ import annotations

import json
from typing import Any, Callable

from vsm.app.dto.backend_request import BackendWorkerRequest, BackendWorkerResponse


def run_worker_loop(
    *,
    parser: Any,
    base_args: list[str],
    stdin: Any,
    stdout_write: Callable[[str], None],
    worker_result_prefix: str,
    execute_request: Callable[[Any, str], Any],
    build_error_response: Callable[[str, Exception], BackendWorkerResponse],
) -> None:
    for raw_line in stdin:
        line = raw_line.strip()
        if not line:
            continue

        request_id = ""
        try:
            request_payload = json.loads(line)
            request = BackendWorkerRequest.from_payload(request_payload)
            request_id = request.request_id
            parsed_args = parser.parse_args(base_args + ["--json"] + request.args)
            result = execute_request(parsed_args, request_id)
            response = BackendWorkerResponse(
                request_id=request_id,
                success=True,
                result=result,
            )
        except Exception as error:
            response = build_error_response(request_id, error)

        stdout_write(
            f"{worker_result_prefix}{json.dumps(response.to_payload(), ensure_ascii=False)}"
        )
