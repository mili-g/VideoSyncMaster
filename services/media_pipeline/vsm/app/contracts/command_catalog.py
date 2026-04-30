from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class CommandArgumentSpec:
    name: str
    required: bool = False
    description: str = ""

    def to_payload(self) -> dict[str, object]:
        return {
            "name": self.name,
            "required": self.required,
            "description": self.description,
        }


@dataclass(frozen=True)
class BackendCommandSpec:
    name: str
    description: str
    category: str
    args: tuple[CommandArgumentSpec, ...] = field(default_factory=tuple)
    json_supported: bool = True

    def required_args(self) -> list[str]:
        return [arg.name for arg in self.args if arg.required]

    def describe(self) -> str:
        required = self.required_args()
        required_suffix = f" | required: {', '.join(required)}" if required else ""
        return f"{self.name} ({self.category}) - {self.description}{required_suffix}"

    def to_payload(self) -> dict[str, object]:
        return {
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "json_supported": self.json_supported,
            "args": [arg.to_payload() for arg in self.args],
        }


def build_backend_command_catalog() -> tuple[BackendCommandSpec, ...]:
    return (
        BackendCommandSpec(
            name="test_asr",
            description="Run ASR on input media and return subtitle segments.",
            category="recognition",
            args=(
                CommandArgumentSpec("input", required=True, description="Source media path"),
                CommandArgumentSpec("asr", description="ASR engine name"),
                CommandArgumentSpec("ori_lang", description="Original language hint"),
                CommandArgumentSpec("output_dir", description="Intermediate output directory"),
            ),
            json_supported=True,
        ),
        BackendCommandSpec(
            name="translate_text",
            description="Translate plain text or subtitle JSON into target language.",
            category="translation",
            args=(
                CommandArgumentSpec("input", required=True, description="Source text or subtitle JSON"),
                CommandArgumentSpec("lang", required=True, description="Target language"),
            ),
            json_supported=True,
        ),
        BackendCommandSpec(
            name="test_tts",
            description="Synthesize a preview TTS audio clip.",
            category="tts",
            args=(
                CommandArgumentSpec("input", required=True, description="Text to synthesize"),
                CommandArgumentSpec("output", required=True, description="Output audio path"),
                CommandArgumentSpec("tts_service", description="TTS engine name"),
                CommandArgumentSpec("lang", description="Target language"),
            ),
            json_supported=True,
        ),
        BackendCommandSpec(
            name="test_align",
            description="Align a single audio clip to a target duration.",
            category="audio",
            args=(
                CommandArgumentSpec("input", required=True, description="Source audio path"),
                CommandArgumentSpec("output", required=True, description="Aligned audio output path"),
                CommandArgumentSpec("duration", required=True, description="Target duration in seconds"),
            ),
            json_supported=True,
        ),
        BackendCommandSpec(
            name="merge_video",
            description="Merge generated dubbing audio segments back into the source video.",
            category="render",
            args=(
                CommandArgumentSpec("input", required=True, description="Source video path"),
                CommandArgumentSpec("ref", required=True, description="Segment JSON path"),
                CommandArgumentSpec("output", required=True, description="Rendered video output path"),
                CommandArgumentSpec("strategy", description="Video sync strategy"),
                CommandArgumentSpec("audio_mix_mode", description="Audio mix policy"),
            ),
            json_supported=True,
        ),
        BackendCommandSpec(
            name="analyze_video",
            description="Inspect source media metadata for preview and diagnostics.",
            category="media",
            args=(CommandArgumentSpec("input", required=True, description="Source media path"),),
            json_supported=True,
        ),
        BackendCommandSpec(
            name="transcode_video",
            description="Transcode media into a preview-compatible format.",
            category="media",
            args=(
                CommandArgumentSpec("input", required=True, description="Source media path"),
                CommandArgumentSpec("output", required=True, description="Transcoded media output path"),
            ),
            json_supported=True,
        ),
        BackendCommandSpec(
            name="dub_video",
            description="Run end-to-end dubbing workflow in a single backend command.",
            category="workflow",
            args=(
                CommandArgumentSpec("input", required=True, description="Source video path"),
                CommandArgumentSpec("output", required=True, description="Dubbed video output path"),
                CommandArgumentSpec("lang", description="Target language"),
            ),
            json_supported=True,
        ),
        BackendCommandSpec(
            name="check_audio_files",
            description="Validate generated audio artifacts and return detected durations.",
            category="diagnostics",
            args=(CommandArgumentSpec("input", required=True, description="Audio path or JSON list"),),
            json_supported=True,
        ),
        BackendCommandSpec(
            name="generate_single_tts",
            description="Generate dubbing audio for a single subtitle segment.",
            category="tts",
            args=(
                CommandArgumentSpec("input", required=True, description="Source media path"),
                CommandArgumentSpec("output", required=True, description="Generated audio output path"),
                CommandArgumentSpec("text", required=True, description="Subtitle text"),
                CommandArgumentSpec("duration", required=True, description="Duration budget in seconds"),
            ),
            json_supported=True,
        ),
        BackendCommandSpec(
            name="generate_batch_tts",
            description="Generate dubbing audio for a subtitle segment batch.",
            category="tts",
            args=(
                CommandArgumentSpec("input", required=True, description="Source media path"),
                CommandArgumentSpec("output", required=True, description="Audio output directory"),
                CommandArgumentSpec("ref", required=True, description="Subtitle segment JSON path"),
                CommandArgumentSpec("lang", description="Target language"),
            ),
            json_supported=True,
        ),
        BackendCommandSpec(
            name="prepare_reference_audio",
            description="Prepare or extract a stable reference audio sample for narration flows.",
            category="tts",
            args=(
                CommandArgumentSpec("input", required=True, description="Source media path"),
                CommandArgumentSpec("ref", required=True, description="Reference subtitle JSON path"),
                CommandArgumentSpec("output", required=True, description="Working directory"),
            ),
            json_supported=True,
        ),
        BackendCommandSpec(
            name="warmup_tts_runtime",
            description="Warm up or switch the active TTS runtime and model profile.",
            category="runtime",
            args=(
                CommandArgumentSpec("tts_service", required=True, description="TTS engine name"),
                CommandArgumentSpec("tts_model_profile", description="Model profile identifier"),
            ),
            json_supported=True,
        ),
        BackendCommandSpec(
            name="switch_runtime_profile",
            description="Switch backend dependency/runtime profile before model execution.",
            category="runtime",
            args=(
                CommandArgumentSpec("runtime_profile", description="Runtime profile: auto, current, qwen3, indextts"),
                CommandArgumentSpec("tts_service", description="Optional TTS service hint"),
                CommandArgumentSpec("asr", description="Optional ASR service hint"),
            ),
            json_supported=True,
        ),
    )


def get_backend_command_names() -> list[str]:
    return sorted(command.name for command in build_backend_command_catalog())


def describe_backend_commands() -> list[str]:
    return [command.describe() for command in build_backend_command_catalog()]


def serialize_backend_command_catalog() -> list[dict[str, object]]:
    return [command.to_payload() for command in build_backend_command_catalog()]
