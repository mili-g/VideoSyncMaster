#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VideoSync 打包工具 (Python 版)
使用 Python zipfile 模块替代 tar 命令，提供更稳定的大文件打包能力
"""

import os
import sys
import shutil
import subprocess
import zipfile
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from services.media_pipeline.bootstrap.path_layout import resolve_env_cache_dir

# 彩色输出支持
try:
    from colorama import init, Fore, Style
    init(autoreset=True)
    HAS_COLOR = True
except ImportError:
    HAS_COLOR = False
    class Fore:
        GREEN = YELLOW = RED = CYAN = ""
    class Style:
        RESET_ALL = BRIGHT = ""


def resolve_first_existing(*candidates: Path) -> Path:
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


@dataclass(frozen=True)
class ProjectLayout:
    root_dir: Path
    ui_dir: Path
    backend_dir: Path
    python_dir: Path
    models_dir: Path
    env_cache_dir: Path
    qwen_asr_dir: Path
    vc_redist_path: Path
    installer_script_path: Path

    @property
    def ui_release_dir(self) -> Path:
        return self.ui_dir / "release"


def get_ui_dir(root_dir: Path) -> Path:
    return resolve_first_existing(
        root_dir / "apps" / "desktop" / "ui",
        root_dir / "ui"
    )


def get_backend_dir(root_dir: Path) -> Path:
    return resolve_first_existing(
        root_dir / "services" / "media_pipeline",
        root_dir / "backend"
    )


def get_python_dir(root_dir: Path) -> Path:
    return resolve_first_existing(
        root_dir / "runtime" / "python",
        root_dir / "python"
    )


def get_models_dir(root_dir: Path) -> Path:
    return root_dir / "models"


def get_env_cache_dir(root_dir: Path) -> Path:
    return Path(resolve_env_cache_dir(str(root_dir)))


def get_qwen_asr_dir(root_dir: Path) -> Path:
    return resolve_first_existing(
        root_dir / "models" / "asr" / "qwen3",
        root_dir / "Qwen3-ASR"
    )


def get_vc_redist_path(root_dir: Path) -> Path:
    return resolve_first_existing(
        root_dir / "resources" / "packaging" / "runtime" / "VC_redist.x64.exe",
        root_dir / "VC_redist.x64.exe"
    )


def get_installer_script_path(root_dir: Path) -> Path:
    return resolve_first_existing(
        root_dir / "resources" / "packaging" / "installer" / "patch_installer.iss",
        root_dir / "patch_installer.iss"
    )


def build_project_layout(root_dir: Path) -> ProjectLayout:
    return ProjectLayout(
        root_dir=root_dir,
        ui_dir=get_ui_dir(root_dir),
        backend_dir=get_backend_dir(root_dir),
        python_dir=get_python_dir(root_dir),
        models_dir=get_models_dir(root_dir),
        env_cache_dir=get_env_cache_dir(root_dir),
        qwen_asr_dir=get_qwen_asr_dir(root_dir),
        vc_redist_path=get_vc_redist_path(root_dir),
        installer_script_path=get_installer_script_path(root_dir),
    )


def print_header(text: str):
    """打印标题"""
    if HAS_COLOR:
        print(f"\n{Fore.CYAN}{Style.BRIGHT}{'='*50}")
        print(f"{text:^50}")
        print(f"{'='*50}{Style.RESET_ALL}\n")
    else:
        print(f"\n{'='*50}")
        print(f"{text:^50}")
        print(f"{'='*50}\n")


def print_success(text: str):
    """打印成功消息"""
    print(f"{Fore.GREEN}[OK] {text}{Style.RESET_ALL}" if HAS_COLOR else f"[OK] {text}")


def print_error(text: str):
    """打印错误消息"""
    print(f"{Fore.RED}[ERROR] {text}{Style.RESET_ALL}" if HAS_COLOR else f"[ERROR] {text}")


def print_info(text: str):
    """打印信息"""
    print(f"{Fore.YELLOW}[INFO] {text}{Style.RESET_ALL}" if HAS_COLOR else f"[INFO] {text}")


def get_dir_size(path: Path) -> int:
    """获取目录大小（字节）"""
    total = 0
    for entry in path.rglob('*'):
        if entry.is_file():
            total += entry.stat().st_size
    return total


def format_size(bytes_size: int) -> str:
    """格式化文件大小"""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if bytes_size < 1024.0:
            return f"{bytes_size:.2f} {unit}"
        bytes_size /= 1024.0
    return f"{bytes_size:.2f} TB"


def create_zip_with_progress(
    output_path: Path,
    source_dirs: list,
    exclude_patterns: Optional[list] = None,
    compression: int = zipfile.ZIP_DEFLATED,
    compresslevel: Optional[int] = 6
):
    """
    创建 ZIP 压缩包并显示进度
    
    Args:
        output_path: 输出 ZIP 文件路径
        source_dirs: 源目录列表，格式为 [(Path, archive_prefix), ...]
        exclude_patterns: 排除的文件模式列表
    """
    exclude_patterns = exclude_patterns or []
    
    # 计算总文件数
    print_info("正在统计文件...")
    all_files = []
    for src_path, prefix in source_dirs:
        for entry in src_path.rglob('*'):
            if entry.is_file():
                # 检查排除模式
                should_exclude = False
                for pattern in exclude_patterns:
                    if pattern in str(entry).replace('\\', '/'):
                        should_exclude = True
                        break
                if not should_exclude:
                    archive_name = str(prefix / entry.relative_to(src_path)) if prefix else str(entry.relative_to(src_path))
                    all_files.append((entry, archive_name))
    
    total_files = len(all_files)
    print_info(f"共需打包 {total_files} 个文件")
    
    # 创建 ZIP
    zip_kwargs = {"compression": compression}
    if compression != zipfile.ZIP_STORED and compresslevel is not None:
        zip_kwargs["compresslevel"] = compresslevel

    with zipfile.ZipFile(output_path, 'w', **zip_kwargs) as zipf:
        for idx, (file_path, archive_name) in enumerate(all_files, 1):
            zipf.write(file_path, archive_name)
            
            # 每 100 个文件显示一次进度
            if idx % 100 == 0 or idx == total_files:
                progress = (idx / total_files) * 100
                print(f"\r  打包进度: {idx}/{total_files} ({progress:.1f}%)    ", end='', flush=True)
        
        print()  # 换行
    
    final_size = output_path.stat().st_size
    print_success(f"压缩完成！最终大小: {format_size(final_size)}")


def run_npm_build(
    ui_dir: Path,
    *,
    output_dir_name: str = "release-package",
    dir_only: bool = True
) -> Optional[Path]:
    """运行前端/桌面端构建并返回 win-unpacked 目录"""
    print_info("正在编译 UI 界面与核心进程...")
    try:
        # 检查 node_modules
        if not (ui_dir / "node_modules").exists():
            print_info("检测到未安装依赖，正在安装...")
            subprocess.run("npm install", cwd=ui_dir, shell=True, check=True)

        output_dir = ui_dir / output_dir_name
        if output_dir.exists():
            print_info(f"清理旧构建目录: {output_dir}")
            shutil.rmtree(output_dir, ignore_errors=True)

        if dir_only:
            build_cmd = (
                f"npx tsc && "
                f"npx vite build && "
                f"npx electron-builder --dir --config.directories.output={output_dir_name}"
            )
        else:
            build_cmd = "npm run build"

        result = subprocess.run(
            build_cmd,
            cwd=ui_dir,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            shell=True
        )
        if result.returncode != 0:
            print_error("构建失败！")
            if result.stdout.strip():
                print(result.stdout)
            if result.stderr.strip():
                print(result.stderr)
            return None
        print_success("构建完成")
        win_unpacked = output_dir / "win-unpacked" if dir_only else ui_dir / "release" / "win-unpacked"
        if not win_unpacked.exists():
            print_error(f"未找到构建输出目录: {win_unpacked}")
            return None
        return win_unpacked
    except Exception as e:
        print_error(f"构建失败: {e}")
        return None


def ensure_file_copied(src: Path, dst: Path):
    """复制单个文件到目标位置"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def copy_tree_with_progress(src: Path, dst: Path, label: str):
    """复制目录并输出体积信息"""
    if not src.exists():
        raise FileNotFoundError(f"目录不存在: {src}")

    size_bytes = get_dir_size(src)
    print_info(f"复制 {label}: {src} -> {dst} ({format_size(size_bytes)})")
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def prepare_common_runtime_files(layout: ProjectLayout, portable_root: Path):
    """准备便携包公共运行文件"""
    req_file = layout.root_dir / "requirements.txt"
    if req_file.exists():
        print_info("包含 requirements.txt")
        ensure_file_copied(req_file, portable_root / "requirements.txt")
        ensure_file_copied(req_file, portable_root / "services" / "media_pipeline" / "requirements.txt")

    if layout.vc_redist_path.exists():
        print_info("包含 VC++ Runtime 安装程序")
        ensure_file_copied(layout.vc_redist_path, portable_root / "VC_redist.x64.exe")


def write_portable_readme(portable_root: Path):
    """写入便携版说明"""
    readme_path = portable_root / "PORTABLE_README.txt"
    content = """VideoSync Portable
==================

启动方式:
1. 直接双击 VideoSync.exe

目录说明:
- python/: 内置 Python 运行环境
- models/: 本地模型目录
- services/media_pipeline/: 后端逻辑与运行桥接代码
- models/asr/qwen3/: Qwen ASR 资源
- storage/cache/env/: 依赖版本切换缓存

注意事项:
- 请将整个目录保存在本地磁盘，不要只拷贝 VideoSync.exe
- 首次启动前建议确认显卡驱动与 VC++ Runtime 已安装
- 如需迁移到其它电脑，请整体复制整个便携目录
"""
    readme_path.write_text(content, encoding="utf-8")


def write_program_only_readme(portable_root: Path):
    """写入纯程序包说明"""
    readme_path = portable_root / "PROGRAM_ONLY_README.txt"
    content = """VideoSync Program Only
======================

这是纯程序包，不包含 Python 运行环境和模型文件。

使用前请将以下目录放到程序根目录，与 VideoSync.exe 同级：

1. python/
   - 需要完整的便携 Python 环境
   - 必须包含 python/python.exe

2. models/
   - 需要完整模型目录
   - 保持原有子目录结构，不要只拷单个模型文件

推荐目录结构：

VideoSync/
  VideoSync.exe
  python/
  models/
  services/
    media_pipeline/
  ...

说明：
- services/media_pipeline/ 已包含在程序包内
- ffmpeg 等后端资源已随程序提供
- 若缺少 python/ 或 models/，相关功能将无法运行
"""
    readme_path.write_text(content, encoding="utf-8")


def build_portable_layout(layout: ProjectLayout, layout_root: Path, include_models: bool = True):
    """构建完整便携目录"""
    win_unpacked = run_npm_build(layout.ui_dir, output_dir_name="release-package", dir_only=True)
    if not win_unpacked:
        return None

    if not layout.python_dir.exists():
        raise FileNotFoundError(f"找不到 Python 环境: {layout.python_dir}")
    if include_models and not layout.models_dir.exists():
        raise FileNotFoundError(f"找不到模型目录: {layout.models_dir}")

    if layout_root.exists():
        print_info(f"清理旧便携目录: {layout_root}")
        shutil.rmtree(layout_root)

    layout_root.mkdir(parents=True, exist_ok=True)

    print_header("构建便携目录")
    copy_tree_with_progress(win_unpacked, layout_root, "程序主体")
    copy_tree_with_progress(layout.python_dir, layout_root / "python", "Python 环境")

    if include_models:
        copy_tree_with_progress(layout.models_dir, layout_root / "models", "模型目录")

    qwen_target_dir = layout_root / "models" / "asr" / "qwen3"
    if layout.qwen_asr_dir.exists() and not qwen_target_dir.exists():
        copy_tree_with_progress(layout.qwen_asr_dir, qwen_target_dir, "Qwen3-ASR 资源")

    if layout.env_cache_dir.exists() and any(layout.env_cache_dir.iterdir()):
        copy_tree_with_progress(layout.env_cache_dir, layout_root / "storage" / "cache" / "env", "依赖版本缓存")

    prepare_common_runtime_files(layout, layout_root)
    write_portable_readme(layout_root)
    return layout_root


def get_version(ui_dir: Path) -> str:
    """从 package.json 获取版本号"""
    try:
        with open(ui_dir / "package.json", "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("version", "0.0.0")
    except:
        return "1.0.0"


def build_full_portable(root_dir: Path):
    """构建全量便携包"""
    layout = build_project_layout(root_dir)
    version = get_version(layout.ui_dir)
    print_header(f"构建全量便携包 v{version}")
    
    portable_dir = layout.ui_release_dir / f"VideoSync_v{version}_Portable"
    output_file = root_dir / f"VideoSync_v{version}_Full_Portable.zip"

    try:
        built_layout = build_portable_layout(layout, portable_dir, include_models=True)
    except Exception as e:
        print_error(f"构建便携目录失败: {e}")
        return

    if not built_layout:
        return

    if output_file.exists():
        print_info("清理旧的压缩包...")
        output_file.unlink()

    print_success(f"便携目录已生成: {built_layout}")
    print_info("开始打包完整便携压缩包（模型较大，可能耗时较长）...")
    try:
        exclude_patterns = [
            '__pycache__', '.pyc', '.git'
        ]

        create_zip_with_progress(
            output_file,
            [(built_layout, Path(""))],
            exclude_patterns=exclude_patterns,
            compression=zipfile.ZIP_STORED,
            compresslevel=None
        )
        print_success(f"全量包已生成: {output_file}")
    except Exception as e:
        print_error(f"打包失败: {e}")


def build_portable_runtime_only(root_dir: Path):
    """构建无模型便携包"""
    layout = build_project_layout(root_dir)
    version = get_version(layout.ui_dir)
    print_header(f"构建无模型便携包 v{version}")

    portable_dir = layout.ui_release_dir / f"VideoSync_v{version}_Portable_NoModels"
    output_file = root_dir / f"VideoSync_v{version}_Portable_NoModels.zip"

    try:
        built_layout = build_portable_layout(layout, portable_dir, include_models=False)
    except Exception as e:
        print_error(f"构建便携目录失败: {e}")
        return

    if not built_layout:
        return

    if output_file.exists():
        print_info("清理旧的无模型便携包...")
        output_file.unlink()

    print_success(f"无模型便携目录已生成: {built_layout}")
    print_info("开始打包无模型便携 ZIP...")
    try:
        create_zip_with_progress(
            output_file,
            [(built_layout, Path(""))],
            exclude_patterns=['__pycache__', '.pyc', '.git'],
            compression=zipfile.ZIP_STORED,
            compresslevel=None
        )
        print_success(f"无模型便携包已生成: {output_file}")
    except Exception as e:
        print_error(f"打包失败: {e}")


def build_program_only(root_dir: Path):
    """构建纯程序包（不含 python 和 models）"""
    layout = build_project_layout(root_dir)
    version = get_version(layout.ui_dir)
    print_header(f"构建纯程序包 v{version}")

    portable_dir = layout.ui_release_dir / f"VideoSync_v{version}_ProgramOnly"
    output_file = root_dir / f"VideoSync_v{version}_ProgramOnly.zip"

    win_unpacked = run_npm_build(layout.ui_dir)
    if not win_unpacked:
        return

    if not win_unpacked.exists():
        print_error(f"找不到构建输出目录: {win_unpacked}")
        return

    if portable_dir.exists():
        print_info(f"清理旧纯程序目录: {portable_dir}")
        shutil.rmtree(portable_dir)

    portable_dir.mkdir(parents=True, exist_ok=True)

    print_header("构建纯程序目录")
    copy_tree_with_progress(win_unpacked, portable_dir, "程序主体")

    write_program_only_readme(portable_dir)

    if output_file.exists():
        print_info("清理旧的纯程序包...")
        output_file.unlink()

    print_success(f"纯程序目录已生成: {portable_dir}")
    print_info("开始打包纯程序 ZIP...")
    try:
        create_zip_with_progress(
            output_file,
            [(portable_dir, Path(""))],
            exclude_patterns=['__pycache__', '.pyc', '.git', '.cache'],
            compression=zipfile.ZIP_STORED,
            compresslevel=None
        )
        print_success(f"纯程序包已生成: {output_file}")
    except Exception as e:
        print_error(f"打包失败: {e}")


def build_update_patch(root_dir: Path):
    """构建轻量更新补丁"""
    layout = build_project_layout(root_dir)
    version = get_version(layout.ui_dir)
    print_header(f"构建轻量更新补丁 v{version}")
    
    ui_dir = layout.ui_dir
    output_file = root_dir / f"VideoSync_v{version}_Update_Patch.zip"
    
    # 1. 构建
    win_unpacked = run_npm_build(ui_dir, output_dir_name="release-patch", dir_only=True)
    if not win_unpacked:
        return
    
    # 3. 清理旧文件
    if output_file.exists():
        print_info("清理旧的补丁包...")
        output_file.unlink()
    
    # 4. 准备辅助文件
    req_file = root_dir / "requirements.txt"
    if req_file.exists():
        print_info("正在包含 requirements.txt...")
        shutil.copy2(req_file, win_unpacked / "requirements.txt")
    
    if layout.vc_redist_path.exists():
        print_info("正在包含 VC++ Runtime 安装程序...")
        shutil.copy2(layout.vc_redist_path, win_unpacked / "VC_redist.x64.exe")

    
    # 5. 打包
    print_info("开始打包...")
    try:
        create_zip_with_progress(
            output_file,
            [(win_unpacked, Path(""))],
            exclude_patterns=['__pycache__', '.pyc', '.git', '.cache', 'python/']
        )
        print_success(f"轻量补丁已生成: {output_file}")
    except Exception as e:
        print_error(f"打包失败: {e}")


def build_installer(root_dir: Path):
    """构建傻瓜式更新包"""
    print_header("构建傻瓜式一键更新包")
    
    layout = build_project_layout(root_dir)
    
    # 1. 构建
    win_unpacked = run_npm_build(layout.ui_dir, output_dir_name="release", dir_only=False)
    if not win_unpacked:
        return
    
    # 2. 准备辅助文件
    req_file = root_dir / "requirements.txt"
    if req_file.exists() and win_unpacked.exists():
        print_info("正在包含 requirements.txt...")
        shutil.copy2(req_file, win_unpacked / "requirements.txt")
    
    # 3. 调用 Inno Setup
    iscc_path = None
    iscc_in_path = shutil.which("iscc")
    if iscc_in_path:
        iscc_path = Path(iscc_in_path)
    else:
        possible_paths = [
            Path(r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe"),
            Path(r"C:\Program Files\Inno Setup 6\ISCC.exe"),
            Path(os.environ.get("LOCALAPPDATA", r"C:\Users\Default\AppData\Local")) / "Programs" / "Inno Setup 6" / "ISCC.exe",
            Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Inno Setup 6" / "ISCC.exe",
            Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Inno Setup 6" / "ISCC.exe",
        ]
        for p in possible_paths:
            if p.exists():
                iscc_path = p
                break
                
    if not iscc_path:
        print_error("未找到 Inno Setup (ISCC.exe)")
        print_info("请确保已安装 Inno Setup 6。如果已安装，请尝试将安装目录添加到系统环境变量 PATH 中。")
        return
    
    if not layout.installer_script_path.exists():
        print_error(f"未找到安装脚本: {layout.installer_script_path}")
        return
    
    print_info("正在调用 Inno Setup...")
    try:
        result = subprocess.run(
            [str(iscc_path), str(layout.installer_script_path)],
            cwd=root_dir,
            capture_output=True,
            text=True
        )
        if result.returncode != 0:
            print_error("编译失败！")
            print(result.stdout)
            print(result.stderr)
            return
        print_success(f"一键更新包已生成，请查看 {layout.ui_release_dir} 目录")
    except Exception as e:
        print_error(f"编译失败: {e}")


def clean_build_artifacts(root_dir: Path):
    """清理构建产物"""
    print_header("清理构建产物")
    
    layout = build_project_layout(root_dir)
    
    # 清理 UI 构建产物
    dirs_to_clean = [
        layout.ui_dir / "dist",
        layout.ui_dir / "dist-electron",
        layout.ui_dir / "release",
        layout.ui_dir / "release-package",
        layout.ui_dir / "release-patch",
    ]
    
    for dir_path in dirs_to_clean:
        if dir_path.exists():
            print_info(f"清理 {dir_path.name}...")
            shutil.rmtree(dir_path)
    
    # 清理打包产物
    for zip_file in root_dir.glob("*.zip"):
        print_info(f"清理 {zip_file.name}...")
        zip_file.unlink()
    
    # 清理 Python 缓存
    print_info("清理 Python 缓存...")
    for pycache in layout.backend_dir.rglob("__pycache__"):
        shutil.rmtree(pycache)
    
    for pyc in layout.backend_dir.rglob("*.pyc"):
        pyc.unlink()
    
    print_success("清理完成！")


def main():
    """主函数"""
    cwd_root = Path(os.getcwd()).resolve()
    script_root = Path(__file__).resolve().parent

    if get_ui_dir(cwd_root).exists() and get_backend_dir(cwd_root).exists():
        root_dir = cwd_root
    elif get_ui_dir(script_root).exists() and get_backend_dir(script_root).exists():
        root_dir = script_root
        if cwd_root != script_root:
            print_info(f"检测到当前工作目录无效，已自动切换到脚本目录: {script_root}")
    else:
        print_error(f"当前目录 {cwd_root} 不是有效的 VideoSync 项目根目录！")
        print_info("请在项目根目录下运行此脚本（包含桌面端 UI 与后端服务源码的目录）")
        input("\n按回车键退出...")
        return
    
    while True:
        print_header("VideoSync 应用打包工具 (Python 版)")
        print("  1. 构建纯程序包 (~200MB)")
        print("     [仅包含程序本体，需自行放置 python/ 和 models/ 到程序根目录]")
        print()
        print("  2. 构建全量便携包 (70GB+)")
        print("     [包含：程序本体 + Python 环境 + 全部模型，可直接双击 VideoSync.exe]")
        print()
        print("  3. 构建无模型便携包 (~10GB+)")
        print("     [包含：程序本体 + Python 环境 + 依赖缓存，不含 models/]")
        print()
        print("  4. 构建轻量逻辑补丁 (~50MB ZIP)")
        print("     [包含：仅程序逻辑，环境/模型需已有]")
        print()
        print("  5. 构建傻瓜式一键更新包 (~50MB EXE)")
        print("     [需要电脑已安装 Inno Setup 6]")
        print()
        print("  6. 清理构建产物 (Clean)")
        print("  7. 退出")
        print()
        
        try:
            choice = input("请输入选项 (1-7): ").strip()
            
            if choice == "1":
                build_program_only(root_dir)
            elif choice == "2":
                build_full_portable(root_dir)
            elif choice == "3":
                build_portable_runtime_only(root_dir)
            elif choice == "4":
                build_update_patch(root_dir)
            elif choice == "5":
                build_installer(root_dir)
            elif choice == "6":
                clean_build_artifacts(root_dir)
            elif choice == "7":
                print_info("再见！")
                break
            else:
                print_error("无效选项，请重新输入")
            
            input("\n按回车键继续...")
            
        except KeyboardInterrupt:
            print("\n\n中断操作")
            break
        except Exception as e:
            print_error(f"发生错误: {e}")
            input("\n按回车键继续...")


if __name__ == "__main__":
    main()
