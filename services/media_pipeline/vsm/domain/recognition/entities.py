from __future__ import annotations

from dataclasses import dataclass, field

from vsm.domain.recognition.contracts import AsrCapability


@dataclass
class RecognitionCatalog:
    providers: dict[str, AsrCapability] = field(default_factory=dict)

    def register(self, capability: AsrCapability) -> None:
        self.providers[capability.provider_id] = capability

