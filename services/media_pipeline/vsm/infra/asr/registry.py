from __future__ import annotations

from dataclasses import dataclass, field

from vsm.domain.recognition.contracts import AsrCapability, AsrProvider


@dataclass
class AsrRegistry:
    _providers: dict[str, AsrProvider] = field(default_factory=dict)

    def register(self, provider: AsrProvider) -> None:
        self._providers[provider.provider_id] = provider

    def get(self, provider_id: str) -> AsrProvider:
        try:
            return self._providers[provider_id]
        except KeyError as error:
            raise KeyError(f"Unknown ASR provider: {provider_id}") from error

    def list_capabilities(self) -> list[AsrCapability]:
        return [provider.describe_capability() for provider in self._providers.values()]

    def list_provider_ids(self) -> list[str]:
        return list(self._providers.keys())

