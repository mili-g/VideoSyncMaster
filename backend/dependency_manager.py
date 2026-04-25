
import sys
import subprocess
import os
import shutil
import glob
import importlib.util
import importlib.metadata
from event_protocol import emit_event, emit_issue, emit_progress, emit_stage

# ============================================================
# Configuration
# ============================================================
# Packages to swap together for each environment profile
_SWAP_PACKAGES = ["transformers", "tokenizers", "accelerate"]

# Version profiles
PROFILE_INDEX_TTS = "4.52.1"  # For IndexTTS
PROFILE_QWEN3 = "4.57.3"      # For Qwen3-TTS/ASR

def _get_site_packages():
    """Get the site-packages directory path."""
    return os.path.join(os.path.dirname(sys.executable), "Lib", "site-packages")

def _get_env_cache_dir():
    """Get the .env_cache directory in the project root."""
    # backend folder -> parent is project root
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(backend_dir)
    cache_dir = os.path.join(project_root, ".env_cache")
    return cache_dir

def get_installed_version(package_name):
    try:
        return importlib.metadata.version(package_name)
    except importlib.metadata.PackageNotFoundError:
        return None

def check_transformers_version(required_version):
    """
    Check if the installed transformers version matches the required version.
    Returns True if match, False otherwise.
    """
    current_version = get_installed_version("transformers")
    print(f"[DependencyManager] Checking transformers: Current={current_version}, Required={required_version}")
    return current_version == required_version

def install_package(package_spec):
    """
    Install a package using pip.
    """
    print(f"[DependencyManager] Installing {package_spec}...")
    # Add a special flag for frontend to detect and show notification
    print(f"[DEPS_INSTALLING] {package_spec}", flush=True)
    emit_event("deps_installing", "runtime_setup", {"package": package_spec})
    try:
        # Use the current python executable
        # Removed --no-cache-dir for faster re-installs
        # Added --no-input and --no-warn-script-location for non-interactive mode
        cmd = [sys.executable, "-m", "pip", "install", package_spec, "--no-input", "--no-warn-script-location"]
        
        # We want to capture output to show progress if possible, or at least log it
        # Using check_call will stream to stdout/stderr which main.py captures
        subprocess.check_call(cmd)
        print(f"[DependencyManager] Successfully installed {package_spec}")
        print(f"[DEPS_DONE] {package_spec}", flush=True)
        emit_event("deps_done", "runtime_setup", {"package": package_spec})
        return True
    except subprocess.CalledProcessError as e:
        print(f"[DependencyManager] Failed to install {package_spec}: {e}")
        emit_issue(
            "runtime_setup",
            "runtime_repair",
            "error",
            "RUNTIME_INSTALL_FAILED",
            f"依赖安装失败: {package_spec}",
            detail=str(e),
            suggestion="请检查网络、磁盘空间或完整日志"
        )
        return False


def ensure_package_installed(package_name, package_spec=None):
    """
    Ensure a Python package is importable; install it on demand if missing.
    """
    if importlib.util.find_spec(package_name) is not None or get_installed_version(package_name):
        print(f"[DependencyManager] {package_name} already installed.")
        return True

    return install_package(package_spec or package_name)


def _move_package_folders(source_dir, dest_dir, packages):
    """
    Move package folders and their .dist-info directories from source to dest.
    Handles patterns like: transformers, transformers-4.52.1.dist-info
    """
    os.makedirs(dest_dir, exist_ok=True)
    moved_count = 0
    
    for pkg_name in packages:
        # Pattern to match: package folder and dist-info
        patterns = [
            os.path.join(source_dir, pkg_name),  # e.g., transformers/
            os.path.join(source_dir, f"{pkg_name}-*.dist-info"),  # e.g., transformers-4.52.1.dist-info
        ]
        
        for pattern in patterns:
            for path in glob.glob(pattern):
                if os.path.exists(path):
                    dest_path = os.path.join(dest_dir, os.path.basename(path))
                    try:
                        # Remove destination if it already exists (shouldn't happen in normal flow)
                        if os.path.exists(dest_path):
                            if os.path.isdir(dest_path):
                                shutil.rmtree(dest_path)
                            else:
                                os.remove(dest_path)
                        
                        shutil.move(path, dest_path)
                        print(f"  [Swap] Moved: {os.path.basename(path)}")
                        moved_count += 1
                    except Exception as e:
                        print(f"  [Swap] Warning: Failed to move {path}: {e}")
    
    return moved_count


def swap_environment(target_version):
    """
    Instant environment swap using cached package folders.
    Swaps transformers, tokenizers, accelerate to a cached version.
    
    Returns True if swap succeeded (either from cache or pip install), False otherwise.
    """
    current_version = get_installed_version("transformers")
    
    if current_version == target_version:
        print(f"[DependencyManager] Environment already at v{target_version}")
        return True
    
    site_packages = _get_site_packages()
    env_cache = _get_env_cache_dir()
    
    current_cache = os.path.join(env_cache, f"v_{current_version}") if current_version else None
    target_cache = os.path.join(env_cache, f"v_{target_version}")
    
    print(f"[DependencyManager] Swapping environment: v{current_version} -> v{target_version}")
    print(f"[DEPS_INSTALLING] Environment v{target_version}", flush=True)
    emit_stage(
        "runtime_switch",
        "runtime_switch",
        f"正在切换依赖版本到 {target_version}",
        stage_label="正在切换运行环境"
    )
    emit_event("deps_installing", "runtime_switch", {"package": f"Environment v{target_version}"})
    
    # Step 1: Check if target version is in cache
    target_in_cache = os.path.exists(target_cache) and len(os.listdir(target_cache)) > 0
    
    if target_in_cache:
        print(f"[DependencyManager] Target version v{target_version} found in cache. Performing instant swap...")
        emit_progress(
            "runtime_switch",
            "runtime_switch",
            25,
            f"已找到缓存版本 {target_version}",
            stage_label="正在切换运行环境"
        )
        
        # Step 2A: Move current packages to cache (if they exist)
        if current_version and current_cache:
            print(f"  [Swap] Caching current environment v{current_version}...")
            _move_package_folders(site_packages, current_cache, _SWAP_PACKAGES)
        
        # Step 2B: Restore target packages from cache
        print(f"  [Swap] Restoring target environment v{target_version}...")
        restored = _move_package_folders(target_cache, site_packages, _SWAP_PACKAGES)
        
        if restored > 0:
            # Verify
            new_version = get_installed_version("transformers")
            if new_version == target_version:
                print(f"[DependencyManager] Instant swap complete! Now on v{target_version}")
                print(f"[DEPS_DONE] Environment v{target_version}", flush=True)
                emit_progress(
                    "runtime_switch",
                    "runtime_switch",
                    100,
                    f"已切换到版本 {target_version}",
                    stage_label="正在切换运行环境"
                )
                emit_event("deps_done", "runtime_switch", {"package": f"Environment v{target_version}"})
                return True
            else:
                print(f"[DependencyManager] Warning: Swap verification failed. Expected v{target_version}, got v{new_version}")
                emit_issue(
                    "runtime_switch",
                    "runtime_switch",
                    "warn",
                    "RUNTIME_SWITCH_VERIFY_FAILED",
                    "版本切换校验失败",
                    detail=f"Expected {target_version}, got {new_version}",
                    suggestion="请尝试修复运行环境或重建切换缓存"
                )
        else:
            print(f"[DependencyManager] Warning: No packages restored from cache. Cache may be empty or corrupted.")
            emit_issue(
                "runtime_switch",
                "runtime_switch",
                "warn",
                "RUNTIME_CACHE_MISSING",
                "目标缓存不存在或已损坏",
                detail=f"Cache path: {target_cache}",
                suggestion="请执行运行环境修复或重建缓存"
            )
    
    # Step 3: Fallback to pip install if cache miss or swap failed
    print(f"[DependencyManager] Cache miss or swap failed. Falling back to pip install...")
    emit_progress(
        "runtime_switch",
        "runtime_switch",
        60,
        "缓存不可用，正在回退到 pip 安装",
        stage_label="正在切换运行环境"
    )
    
    # First, cache the current version if we haven't already
    if current_version and current_cache and not os.path.exists(current_cache):
        print(f"  [Swap] Caching current environment v{current_version} before installing...")
        _move_package_folders(site_packages, current_cache, _SWAP_PACKAGES)
    
    # Uninstall current packages (they might be partially there)
    for pkg in _SWAP_PACKAGES:
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "uninstall", pkg, "-y", "--no-input"], 
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except:
            pass
    
    # Install target version
    success = install_package(f"transformers=={target_version}")
    
    if success:
        # Also ensure accelerate is at the right version for Qwen3
        if target_version == PROFILE_QWEN3:
            accel_version = get_installed_version("accelerate")
            if accel_version != "1.12.0":
                print(f"[DependencyManager] Installing accelerate==1.12.0 for Qwen3 compatibility...")
                install_package("accelerate==1.12.0")
        
        print(f"[DependencyManager] Successfully switched to v{target_version} via pip")
        print(f"[DEPS_DONE] Environment v{target_version}", flush=True)
        emit_progress(
            "runtime_switch",
            "runtime_switch",
            100,
            f"已切换到版本 {target_version}",
            stage_label="正在切换运行环境"
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
        suggestion="请执行运行环境修复并查看完整日志"
    )
    return False


def ensure_transformers_version(target_version):
    """
    Ensure the specific version of transformers is installed.
    Uses the new swap_environment mechanism for instant switching.
    """
    return swap_environment(target_version)


def check_gpu_deps():
    """
    Check if accelerate is installed (needed for Qwen3)
    """
    if not get_installed_version("accelerate"):
        print("[DependencyManager] accelerate not found. Installing...")
        install_package("accelerate>=1.12.0")

