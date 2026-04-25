# 无内置 Python 的环境自举方案

## 1. 目标

本方案的目标是让 VideoSync 在不打包 `python/` 目录的前提下，仍然可以由终端用户在首次启动时完成环境初始化，并在后续运行中稳定切换不同依赖环境。

该方案必须满足以下现实约束：

- 当前项目存在多个运行链路，且依赖版本并不完全一致
- Qwen / WhisperX 不能简单粗暴合并为同一套环境
- 当前项目已有“切换环境”的使用方式，后续仍应保留该思路
- 运行时不能再写死依赖 `python/python.exe`
- 用户需要看到明确的初始化状态、失败原因和修复入口

结论先行：

- 不内置 Python 是可行的
- 但必须改造成“系统 Python + 本地虚拟环境 + 分环境依赖 + 配置持久化”的架构
- 不能继续使用当前“单 `requirements.txt` + 写死 `python/python.exe`”的模式

---

## 2. 当前项目的实际问题

结合当前代码，存在以下阻塞点：

### 2.1 Electron 主进程写死了 Python 路径

当前文件：

- [`ui/electron/main.ts`](C:/Users/MI/Downloads/VideoSyncMaster/ui/electron/main.ts)

当前代码多处直接查找：

- `projectRoot/python/python.exe`

受影响逻辑包括：

- `run-backend`
- `fix-python-env`
- `check-python-env`
- `download-model`
- `download-file`

这意味着只要不打包 `python/`，现有便携版就无法直接工作。

### 2.2 当前只有一个总依赖文件

当前文件：

- [`requirements.txt`](C:/Users/MI/Downloads/VideoSyncMaster/requirements.txt)

该文件将：

- TTS
- WhisperX
- Qwen
- 音频处理
- 训练/推理相关组件

都混在一起。对于“源码开发者自己装环境”勉强可用，但对于普通终端用户的首次自举安装，风险很高：

- 安装慢
- 冲突难排查
- 某一路线依赖损坏会影响全部功能
- Qwen / WhisperX 的版本要求后续难以独立演进

### 2.3 当前“修复环境”只适合内置 Python

当前 `fix-python-env` 逻辑依赖：

- 有本地 Python 可执行文件
- 有单一 requirements 文件

如果没有内置 Python，这个入口必须整体重构为“环境初始化器”。

---

## 3. 总体架构

建议改为三层结构：

### 3.1 系统 Python 层

用途：

- 仅用于创建虚拟环境
- 仅用于引导安装

要求：

- 用户机器安装一个受支持版本的 Python
- 建议锁定到 `Python 3.10.x`

不建议直接使用用户的全局 Python 跑业务逻辑，原因：

- 全局环境不可控
- 容易被用户其他项目污染
- 升级或卸载后会影响本项目

### 3.2 本地虚拟环境层

在项目根目录或用户数据目录创建独立环境，例如：

```text
VideoSyncMaster/
  .env_cache/
    bootstrap/
    venv-main/
    venv-whisperx/
    venv-qwen/
```

推荐职责划分：

- `venv-main`
  - 通用脚本
  - 环境检查
  - 模型下载
  - 轻量公共依赖

- `venv-whisperx`
  - WhisperX 路线依赖
  - 对齐/VAD/音频处理链

- `venv-qwen`
  - Qwen ASR / Qwen TTS / 翻译相关依赖

如果后续验证发现某些公共依赖可复用，可以在二期再做整合，不建议第一版追求合并。

### 3.3 运行时配置层

增加一个持久化配置文件，例如：

```text
VideoSyncMaster/
  runtime-config.json
```

建议结构：

```json
{
  "schemaVersion": 1,
  "bootstrap": {
    "pythonSource": "system",
    "systemPython": "C:\\\\Python310\\\\python.exe",
    "pythonVersion": "3.10.11",
    "initializedAt": "2026-04-24T16:00:00+08:00"
  },
  "venvs": {
    "main": {
      "path": "C:\\\\Users\\\\MI\\\\Downloads\\\\VideoSyncMaster\\\\.env_cache\\\\venv-main",
      "pythonExe": "C:\\\\Users\\\\MI\\\\Downloads\\\\VideoSyncMaster\\\\.env_cache\\\\venv-main\\\\Scripts\\\\python.exe",
      "status": "ready"
    },
    "whisperx": {
      "path": "C:\\\\Users\\\\MI\\\\Downloads\\\\VideoSyncMaster\\\\.env_cache\\\\venv-whisperx",
      "pythonExe": "C:\\\\Users\\\\MI\\\\Downloads\\\\VideoSyncMaster\\\\.env_cache\\\\venv-whisperx\\\\Scripts\\\\python.exe",
      "status": "ready"
    },
    "qwen": {
      "path": "C:\\\\Users\\\\MI\\\\Downloads\\\\VideoSyncMaster\\\\.env_cache\\\\venv-qwen",
      "pythonExe": "C:\\\\Users\\\\MI\\\\Downloads\\\\VideoSyncMaster\\\\.env_cache\\\\venv-qwen\\\\Scripts\\\\python.exe",
      "status": "ready"
    }
  },
  "active": {
    "asrEnv": "qwen",
    "ttsEnv": "qwen",
    "translationEnv": "qwen"
  }
}
```

该配置文件是后续所有后端启动、环境检测、模型下载、日志提示的唯一事实来源。

---

## 4. 依赖拆分方案

### 4.1 不再只使用一个 `requirements.txt`

建议拆分为：

```text
requirements/
  requirements-bootstrap.txt
  requirements-main.txt
  requirements-whisperx.txt
  requirements-qwen.txt
```

说明：

- `requirements-bootstrap.txt`
  - 只放环境检查或安装器真正需要的轻量依赖
  - 尽量少

- `requirements-main.txt`
  - 通用脚本依赖
  - 不包含重型、强冲突组件

- `requirements-whisperx.txt`
  - WhisperX 路线独占依赖

- `requirements-qwen.txt`
  - Qwen 路线独占依赖

### 4.2 现有 `requirements.txt` 的处理

第一阶段不要直接删除：

- 保留 [`requirements.txt`](C:/Users/MI/Downloads/VideoSyncMaster/requirements.txt) 作为源码兼容入口
- 新增分环境 requirements
- 在 README 和安装器逻辑中逐步切换到新结构

等新方案稳定后，再决定是否废弃总 requirements。

### 4.3 版本策略

这里必须遵守你的项目现实约束：

- Qwen 和 WhisperX 的关键版本不能为了“统一环境”而随意改
- 每套环境应只锁定自己真正需要的版本
- 禁止在方案里默认主张“统一 torch / transformers / whisperx / qwen 全共用一套”

也就是说，本方案明确保留“当前切换方法”的思路，只把它从手工切换提升为“程序可管理的多环境切换”。

---

## 5. 首次启动流程设计

### 5.1 启动判定逻辑

应用启动后按以下顺序检查：

1. 是否存在 `runtime-config.json`
2. 若不存在，进入初始化向导
3. 若存在，检查记录的虚拟环境路径是否仍有效
4. 检查当前活动环境是否可执行
5. 检查关键依赖是否完整
6. 检查模型路径是否存在

若任一步失败，进入“修复环境”页，而不是直接报后端启动失败。

### 5.2 初始化向导步骤

建议 UI 步骤：

1. 检测系统 Python
2. 校验 Python 版本
3. 创建本地虚拟环境
4. 升级 `pip/setuptools/wheel`
5. 安装 `requirements-main.txt`
6. 安装 `requirements-whisperx.txt`
7. 安装 `requirements-qwen.txt`
8. 写入 `runtime-config.json`
9. 执行环境自检
10. 完成

### 5.3 Python 检测策略

Windows 下按以下顺序探测：

1. 用户手动指定路径
2. `py -3.10`
3. `python`
4. 常见安装位置探测

只接受满足版本要求的 Python，例如：

- `>=3.10,<3.11`

如果版本不符合，直接提示而不是继续尝试安装。

### 5.4 安装失败后的行为

每个步骤必须有：

- 当前步骤名称
- 正在执行的命令
- stdout 摘要
- stderr 摘要
- 日志文件位置
- “重试当前步骤”按钮
- “跳过并继续”是否允许，要按步骤控制

例如：

- Python 未找到：允许用户重新选择
- `venv-qwen` 安装失败：允许仅保留 WhisperX 相关功能

---

## 6. 运行时环境选择机制

### 6.1 后端启动不再直接拼 `python/python.exe`

所有后端调用改为：

1. 读取 `runtime-config.json`
2. 根据当前任务类型选择目标环境
3. 取出对应 `pythonExe`
4. 启动相应后端脚本

### 6.2 环境选择规则

建议规则：

- 视频分析 / 通用工具 / 模型下载
  - 默认 `venv-main`

- WhisperX ASR / 对齐
  - `venv-whisperx`

- Qwen ASR / Qwen TTS / Qwen 翻译
  - `venv-qwen`

- IndexTTS
  - 根据其真实依赖关系，放入 `venv-main` 或单独拆为 `venv-indextts`

这里不要预设合并，必须按实际依赖核实后落地。

### 6.3 与当前“手动切换环境”逻辑的关系

当前项目已经有“先切到某环境做识别，再切回来继续后续流程”的使用方式。

新方案中，这个行为不应取消，而是变成：

- 用户仍然可以在 UI 中选择当前 ASR / TTS 路线
- 程序自动解析该路线对应的虚拟环境
- 用户不再需要自己手动改外部 Python 目录

也就是说：

- 保留切换思路
- 去掉手工切换成本

---

## 7. 对当前代码的最小改造点

### 7.1 统一 Python 路径解析器

在 [`ui/electron/main.ts`](C:/Users/MI/Downloads/VideoSyncMaster/ui/electron/main.ts) 中新增统一入口，例如：

- `loadRuntimeConfig()`
- `resolvePythonForTask(taskKind, options)`
- `resolveRequirementsForEnv(envName)`

禁止各个 IPC handler 再各自拼路径。

### 7.2 重写以下 IPC 行为

当前需要重构的入口：

- `run-backend`
- `fix-python-env`
- `check-python-env`
- `download-model`
- `download-file`
- `getPythonExe`

建议重命名：

- `fix-python-env` -> `bootstrap-runtime-env`
- `check-python-env` -> `check-runtime-env`

因为未来它们已不再只是“修复 Python”，而是完整环境生命周期管理。

### 7.3 新增环境配置相关 IPC

建议新增：

- `get-runtime-config`
- `set-runtime-config`
- `probe-system-python`
- `create-runtime-venvs`
- `install-runtime-deps`
- `verify-runtime-env`
- `switch-runtime-profile`

### 7.4 打包逻辑调整

便携版若不内置 Python，则打包时应包含：

- `requirements/`
- `backend/`
- `Qwen3-ASR/`
- `runtime bootstrap scripts`
- `README_环境初始化.md` 或同等说明文档

不再依赖：

- `python/`

---

## 8. 推荐目录结构

建议最终结构：

```text
VideoSyncMaster/
  backend/
  Qwen3-ASR/
  models/
  output/
  logs/
  requirements/
    requirements-bootstrap.txt
    requirements-main.txt
    requirements-whisperx.txt
    requirements-qwen.txt
  scripts/
    bootstrap_runtime.py
    verify_runtime.py
    probe_python.py
  .env_cache/
    venv-main/
    venv-whisperx/
    venv-qwen/
  runtime-config.json
  README.md
  README_ENV_SETUP.md
```

说明：

- `scripts/` 用于承载环境初始化脚本
- `.env_cache/` 作为本地生成物，不纳入仓库
- `runtime-config.json` 是运行时事实源

---

## 9. 用户体验设计

### 9.1 首次启动页面

建议显示：

- 当前是否检测到系统 Python
- Python 版本
- 将创建哪些环境
- 每套环境用途
- 预计磁盘占用
- 已安装 / 未安装状态

### 9.2 安装过程反馈

必须做到：

- 用户一眼能看懂当前进行到哪一步
- 出错时能知道是哪套环境失败
- 日志可折叠，不默认刷满整个界面
- 可复制错误摘要

推荐文案形式：

- `正在初始化运行环境 2/5：创建 WhisperX 环境`
- `正在安装依赖：venv-qwen`
- `安装失败：qwen 环境中的 transformers 依赖冲突`

### 9.3 修复入口

建议在模型中心或设置页增加：

- `检测运行环境`
- `重建 main 环境`
- `重建 WhisperX 环境`
- `重建 Qwen 环境`
- `导出运行环境诊断`

这样用户不需要重新打整个包。

---

## 10. 推荐实施顺序

### 第一阶段：最小可落地版本

目标：

- 不再写死 `python/python.exe`
- 可通过系统 Python 创建本地 venv
- 可完成首次初始化

改动：

- 新增 `runtime-config.json`
- 新增统一 Python 解析器
- 新增 `probe-system-python`
- 新增 `bootstrap-runtime-env`
- 只先拆出：
  - `requirements-main.txt`
  - `requirements-qwen.txt`
  - `requirements-whisperx.txt`

### 第二阶段：UI 化和可修复性

目标：

- 普通用户不需要命令行
- 所有初始化和修复都能在 UI 内完成

改动：

- 初始化向导页
- 环境状态页
- 错误摘要和日志导出

### 第三阶段：稳定性增强

目标：

- 支持部分环境损坏后的局部修复
- 支持更精细的任务路由

改动：

- 任务级环境选择
- 局部环境重建
- 启动前环境快速校验缓存

---

## 11. 方案边界

本方案刻意不做以下激进设计：

- 不强推把 Qwen 与 WhisperX 合并为单一环境
- 不默认改动模型版本要求
- 不默认改成联网自动下载安装 Python
- 不默认把所有脚本逻辑并入 Electron 主进程

原因很明确：

- 当前项目已经证明多环境切换比强行合并更稳
- 模型版本要求具有现实约束，不能为了“优雅”而随便改
- 环境自举应先保证稳定，再考虑极致自动化

---

## 12. 最终建议

对于 VideoSync 当前状态，最稳的无内置 Python 路线是：

1. 保留多环境思路
2. 引入 `runtime-config.json`
3. 用系统 Python 只做引导
4. 在 `.env_cache/` 中自动创建多个 venv
5. 将任务路由到对应环境
6. 让 UI 管理初始化、修复、切换和诊断

这条路线的优点是：

- 不破坏你现在已经验证可运行的“分环境切换”思路
- 不需要把关键依赖硬合并
- 对终端用户仍可做到“一次初始化，后续直接使用”
- 后续便携版与开发版都可以共用同一套运行时管理逻辑

---

## 13. 审核重点

你在审核本方案时，建议重点看以下问题：

1. 是否接受继续保留“多环境”而不是合并环境
2. `runtime-config.json` 是否作为唯一事实源
3. `.env_cache/venv-main / venv-whisperx / venv-qwen` 这样的目录结构是否接受
4. `requirements` 是否拆分为多文件
5. 第一阶段是否只做最小可落地版本，不同时推进完整 UI 向导

如果以上 5 点确认，后续就可以进入具体实现设计和代码改造阶段。
