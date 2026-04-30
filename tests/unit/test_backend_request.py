import pathlib
import sys
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from vsm.app.dto.backend_request import BackendWorkerRequest, BackendWorkerResponse


class BackendRequestDtoTests(unittest.TestCase):
    def test_worker_request_normalizes_args(self) -> None:
        request = BackendWorkerRequest.from_payload({"id": 12, "args": ["--action", 3]})

        self.assertEqual("12", request.request_id)
        self.assertEqual(["--action", "3"], request.args)

    def test_worker_response_serializes_error_payload(self) -> None:
        response = BackendWorkerResponse(
            request_id="req-1",
            success=False,
            error="boom",
            error_info={"code": "FAILED"},
        )

        self.assertEqual(
            {
                "id": "req-1",
                "success": False,
                "error": "boom",
                "error_info": {"code": "FAILED"},
            },
            response.to_payload(),
        )


if __name__ == "__main__":
    unittest.main()
