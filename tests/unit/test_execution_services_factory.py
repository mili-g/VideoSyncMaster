import pathlib
import sys
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from bootstrap.execution_services_factory import (
    ExecutionObservabilityDependencies,
    ExecutionRuntimeDependencies,
    ExecutionServiceFactoryContext,
    RuntimeProfileDependencies,
    build_execution_services,
)


class ExecutionServicesFactoryTests(unittest.TestCase):
    def test_switch_runtime_profile_uses_grouped_runtime_dependencies(self) -> None:
        calls: list[tuple[str, str | None]] = []

        services = build_execution_services(
            ExecutionServiceFactoryContext(
                runtime=ExecutionRuntimeDependencies(
                    logger=object(),
                    logging_module=object(),
                    ffmpeg_module=object(),
                    setup_gpu_paths=lambda logger: None,
                ),
                runtime_profiles=RuntimeProfileDependencies(
                    resolve_tts_runner=lambda *args, **kwargs: (None, None),
                    run_tts_runtime_warmup=lambda *args, **kwargs: {"success": True},
                    ensure_transformers_version=lambda version: calls.append(("ensure", version)) or True,
                    check_gpu_deps=lambda: None,
                    get_installed_version=lambda package: "4.57.6",
                    infer_runtime_profile=lambda **kwargs: calls.append(("infer", kwargs.get("requested_profile"))) or "qwen3",
                    normalize_runtime_profile=lambda profile: f"normalized:{profile}",
                    resolve_runtime_profile_version=lambda profile: "4.57.6" if profile == "qwen3" else None,
                ),
                observability=ExecutionObservabilityDependencies(
                    log_business=lambda *args, **kwargs: None,
                    log_error=lambda *args, **kwargs: None,
                    emit_stage=lambda *args, **kwargs: None,
                    emit_error_issue=lambda *args, **kwargs: None,
                    error_result=lambda error: {"error": error},
                    make_error=lambda *args, **kwargs: {"args": args, "kwargs": kwargs},
                    exception_result=lambda error: {"exception": error},
                    emit_progress=lambda *args, **kwargs: None,
                    emit_partial_result=lambda *args, **kwargs: None,
                ),
            )
        )

        result = services.switch_runtime_profile("auto", tts_service="qwen", asr_service="qwen")

        self.assertTrue(result["success"])
        self.assertEqual("normalized:qwen3", result["runtime_profile"])
        self.assertEqual([("infer", "auto"), ("ensure", "4.57.6")], calls)


if __name__ == "__main__":
    unittest.main()
