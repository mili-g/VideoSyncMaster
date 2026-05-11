import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import package_app


class PackageAppInstallerTests(unittest.TestCase):
    def test_build_installer_accepts_electron_builder_setup_output_without_iscc(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root_dir = pathlib.Path(temp_dir)
            ui_dir = root_dir / "apps" / "desktop" / "ui"
            release_dir = ui_dir / "release"
            win_unpacked = release_dir / "win-unpacked"
            win_unpacked.mkdir(parents=True, exist_ok=True)
            release_dir.mkdir(parents=True, exist_ok=True)
            (root_dir / "requirements.txt").write_text("demo==1.0\n", encoding="utf-8")
            runtime_manifest = root_dir / "resources" / "packaging" / "runtime" / "runtime-bootstrap-manifest.json"
            runtime_manifest.parent.mkdir(parents=True, exist_ok=True)
            runtime_manifest.write_text('{"schemaVersion":1}\n', encoding="utf-8")
            setup_exe = release_dir / "VideoSync Setup 1.0.0.exe"
            setup_exe.write_bytes(b"exe")

            layout = package_app.ProjectLayout(
                root_dir=root_dir,
                ui_dir=ui_dir,
                backend_dir=root_dir / "services" / "media_pipeline",
                python_dir=root_dir / "runtime" / "python",
                models_dir=root_dir / "models",
                env_cache_dir=root_dir / "storage" / "cache" / "env",
                qwen_asr_dir=root_dir / "models" / "asr" / "qwen3",
                vc_redist_path=root_dir / "resources" / "packaging" / "runtime" / "VC_redist.x64.exe",
                installer_script_path=root_dir / "resources" / "packaging" / "installer" / "patch_installer.iss",
                runtime_bootstrap_manifest_path=runtime_manifest,
            )

            with patch.object(package_app, "build_project_layout", return_value=layout), patch.object(
                package_app,
                "run_npm_build",
                return_value=win_unpacked,
            ), patch.object(package_app, "get_version", return_value="1.0.0"):
                package_app.build_installer(root_dir)

            self.assertTrue((win_unpacked / "requirements.txt").exists())
            self.assertTrue((win_unpacked / "resources" / "runtime" / "runtime-bootstrap-manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
