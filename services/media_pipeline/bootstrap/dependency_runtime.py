from __future__ import annotations

import glob
import importlib.metadata
import importlib.util
import os
import shutil
import subprocess
import sys

from infra.events import emit_event, emit_issue, emit_progress, emit_stage

from .path_layout import get_project_root, resolve_env_cache_dir


SWAP_PACKAGES = ["transformers", "tokenizers", "accelerate"]
PROFILE_INDEX_TTS = "4.57.6"
PROFILE_QWEN3 = "4.57.6"


def get_site_packages_dir() -> str:
    return os.path.join(os.path.dirname(sys.executable), "Lib", "site-packages")


def get_env_cache_dir(current_file: str | None = None) -> str:
    current_file = current_file or __file__
    backend_dir = os.path.dirname(os.path.abspath(current_file))
    project_root = get_project_root(backend_dir)
    return resolve_env_cache_dir(project_root)


def get_installed_version(package_name: str) -> str | None:
    try:
        return importlib.metadata.version(package_name)
    except importlib.metadata.PackageNotFoundError:
        return None


def check_transformers_version(required_version: str) -> bool:
    current_version = get_installed_version("transformers")
    print(f"[DependencyManager] Checking transformers: Current={current_version}, Required={required_version}")
    return current_version == required_version


def install_package(package_spec: str) -> bool:
    print(f"[DependencyManager] Installing {package_spec}...")
    print(f"[DEPS_INSTALLING] {package_spec}", flush=True)
    emit_event("deps_installing", "runtime_setup", {"package": package_spec})
    try:
        cmd = [sys.executable, "-m", "pip", "install", package_spec, "--no-input", "--no-warn-script-location"]
        subprocess.check_call(cmd)
        print(f"[DependencyManager] Successfully installed {package_spec}")
        print(f"[DEPS_DONE] {package_spec}", flush=True)
        emit_event("deps_done", "runtime_setup", {"package": package_spec})
        return True
    except subprocess.CalledProcessError as error:
        print(f"[DependencyManager] Failed to install {package_spec}: {error}")
        emit_issue(
            "runtime_setup",
            "runtime_repair",
            "error",
            "RUNTIME_INSTALL_FAILED",
            f"依赖安装失败: {package_spec}",
            detail=str(error),
            suggestion="请检查网络、磁盘空间或完整日志",
        )
        return False


def ensure_package_installed(package_name: str, package_spec: str | None = None) -> bool:
    if importlib.util.find_spec(package_name) is not None or get_installed_version(package_name):
        print(f"[DependencyManager] {package_name} already installed.")
        return True

    return install_package(package_spec or package_name)


def move_package_folders(source_dir: str, dest_dir: str, packages: list[str]) -> int:
    os.makedirs(dest_dir, exist_ok=True)
    moved_count = 0

    for package_name in packages:
        patterns = [
            os.path.join(source_dir, package_name),
            os.path.join(source_dir, f"{package_name}-*.dist-info"),
        ]
        for pattern in patterns:
            for path in glob.glob(pattern):
                if not os.path.exists(path):
                    continue
                dest_path = os.path.join(dest_dir, os.path.basename(path))
                try:
                    if os.path.exists(dest_path):
                        if os.path.isdir(dest_path):
                            shutil.rmtree(dest_path)
                        else:
                            os.remove(dest_path)
                    shutil.move(path, dest_path)
                    print(f"  [Swap] Moved: {os.path.basename(path)}")
                    moved_count += 1
                except Exception as error:
                    print(f"  [Swap] Warning: Failed to move {path}: {error}")

    return moved_count


def swap_environment(target_version: str) -> bool:
    current_version = get_installed_version("transformers")
    if current_version == target_version:
        print(f"[DependencyManager] Environment already at v{target_version}")
        return True

    site_packages = get_site_packages_dir()
    env_cache = get_env_cache_dir()
    current_cache = os.path.join(env_cache, f"v_{current_version}") if current_version else None
    target_cache = os.path.join(env_cache, f"v_{target_version}")

    print(f"[DependencyManager] Swapping environment: v{current_version} -> v{target_version}")
    print(f"[DEPS_INSTALLING] Environment v{target_version}", flush=True)
    emit_stage(
        "runtime_switch",
        "runtime_switch",
        f"正在切换依赖版本到 {target_version}",
        stage_label="正在切换运行环境",
    )
    emit_event("deps_installing", "runtime_switch", {"package": f"Environment v{target_version}"})

    target_in_cache = os.path.exists(target_cache) and len(os.listdir(target_cache)) > 0
    if target_in_cache:
        print(f"[DependencyManager] Target version v{target_version} found in cache. Performing instant swap...")
        emit_progress(
            "runtime_switch",
            "runtime_switch",
            25,
            f"已找到缓存版本 {target_version}",
            stage_label="正在切换运行环境",
        )

        if current_version and current_cache:
            print(f"  [Swap] Caching current environment v{current_version}...")
            move_package_folders(site_packages, current_cache, SWAP_PACKAGES)

        print(f"  [Swap] Restoring target environment v{target_version}...")
        restored = move_package_folders(target_cache, site_packages, SWAP_PACKAGES)
        if restored > 0:
            new_version = get_installed_version("transformers")
            if new_version == target_version:
                print(f"[DependencyManager] Instant swap complete! Now on v{target_version}")
                print(f"[DEPS_DONE] Environment v{target_version}", flush=True)
                emit_progress(
                    "runtime_switch",
                    "runtime_switch",
                    100,
                    f"已切换到版本 {target_version}",
                    stage_label="正在切换运行环境",
                )
                emit_event("deps_done", "runtime_switch", {"package": f"Environment v{target_version}"})
                return True

            print(f"[DependencyManager] Warning: Swap verification failed. Expected v{target_version}, got v{new_version}")
            emit_issue(
                "runtime_switch",
                "runtime_switch",
                "warn",
                "RUNTIME_SWITCH_VERIFY_FAILED",
                "版本切换校验失败",
                detail=f"Expected {target_version}, got {new_version}",
                suggestion="请尝试修复运行环境或重建切换缓存",
            )
        else:
            print("[DependencyManager] Warning: No packages restored from cache. Cache may be empty or corrupted.")
            emit_issue(
                "runtime_switch",
                "runtime_switch",
                "warn",
                "RUNTIME_CACHE_MISSING",
                "目标缓存不存在或已损坏",
                detail=f"Cache path: {target_cache}",
                suggestion="请执行运行环境修复或重建缓存",
            )

    print("[DependencyManager] Cache miss or swap failed. Falling back to pip install...")
    emit_progress(
        "runtime_switch",
        "runtime_switch",
        60,
        "缓存不可用，正在回退到 pip 安装",
        stage_label="正在切换运行环境",
    )

    if current_version and current_cache and not os.path.exists(current_cache):
        print(f"  [Swap] Caching current environment v{current_version} before installing...")
        move_package_folders(site_packages, current_cache, SWAP_PACKAGES)

    for package_name in SWAP_PACKAGES:
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "uninstall", package_name, "-y", "--no-input"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass

    success = install_package(f"transformers=={target_version}")
    if success:
        accel_version = get_installed_version("accelerate")
        required_accelerate = "1.12.0" if target_version == PROFILE_QWEN3 else None
        if required_accelerate:
            if accel_version != required_accelerate:
                print(f"[DependencyManager] Installing accelerate=={required_accelerate} for Qwen3 compatibility...")
                install_package(f"accelerate=={required_accelerate}")
        elif not accel_version:
            print("[DependencyManager] accelerate not found after environment switch. Restoring shared runtime dependency...")
            install_package("accelerate>=1.12.0")

        print(f"[DependencyManager] Successfully switched to v{target_version} via pip")
        print(f"[DEPS_DONE] Environment v{target_version}", flush=True)
        emit_progress(
            "runtime_switch",
            "runtime_switch",
            100,
            f"已切换到版本 {target_version}",
            stage_label="正在切换运行环境",
        )
        emit_event("deps_done", "runtime_switch", {"package": f"Environment v{target_version}"})
        return True

    print(f"[DependencyManager] Failed to switch to v{target_version}")
    emit_issue(
        "runtime_switch",
        "runtime_switch",
        "error",
        "RUNTIME_SWITCH_FAILED",
        f"切换到版本 {target_version} 失败",
        detail=f"Current version: {current_version}",
        suggestion="请执行运行环境修复并查看完整日志",
    )
    return False


def ensure_transformers_version(target_version: str) -> bool:
    return swap_environment(target_version)


def check_gpu_deps() -> None:
    if not get_installed_version("accelerate"):
        print("[DependencyManager] accelerate not found. Installing...")
        install_package("accelerate>=1.12.0")
