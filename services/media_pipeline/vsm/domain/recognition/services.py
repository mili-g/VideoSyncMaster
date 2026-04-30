from __future__ import annotations

from vsm.domain.recognition.contracts import AsrProvider, AsrTaskRequest, AsrTaskResult


class RecognitionService:
    def __init__(self, provider: AsrProvider) -> None:
        self._provider = provider

    def transcribe(self, request: AsrTaskRequest) -> AsrTaskResult:
        return self._provider.transcribe(request)

