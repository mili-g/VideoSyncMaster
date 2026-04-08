# VideoSyncMaster 项目架构分析 V2

## 1. 文档目的

本文档基于当前仓库的实际实现，对 `VideoSyncMaster` 的系统结构、模块职责、调用链路、业务边界和扩展风险进行重新梳理。

相较旧版分析，V2 重点解决两个问题：

1. 当前项目已不再是单视频线性流程，而是同时具备单流程和批处理两套工作流。
2. 当前复杂度不只来自 AI 模型本身，还来自 React、Electron、Python 三层之间的参数传递、状态管理和协议协作。

本文档主要用于：

- 新开发者快速理解当前系统结构
- 为后续架构升级和重构提供共识基础
- 为问题排查、功能扩展、参数治理提供全局视角

## 2. 项目定位

`VideoSyncMaster` 是一个本地运行的 AI 视频本地化桌面工具，目标是在单机环境中完成以下流程：

1. 视频导入
2. ASR 识别
3. 字幕编辑与校验
4. 字幕翻译
5. TTS 配音生成
6. 时长对齐与失败重试
7. 音视频合成
8. 输出产物归档

当前产品已具备两条主要业务链路：

- 单文件交互式工作流
- 多文件批处理队列工作流

这意味着系统核心问题已经从“能否完成一条流程”转向“如何稳定编排多流程、多状态、多参数”。

## 3. 当前架构总览

当前系统可以拆为四层：

1. React 渲染层
2. Electron 主进程层
3. Python 后端处理层
4. 本地资源与运行时层

### 3.1 React 渲染层

主要位置：

- `ui/src/App.tsx`
- `ui/src/hooks/useVideoProject.ts`
- `ui/src/hooks/useBatchQueue.ts`
- `ui/src/hooks/useDubbingWorkflow.ts`
- `ui/src/hooks/useTranslationWorkflow.ts`
- `ui/src/hooks/useSubtitleImport.ts`
- `ui/src/components/*`

职责：

- 承载页面结构与交互
- 维护单流程和批处理流程状态
- 组装后端调用参数
- 消费进度、局部结果、最终结果
- 管理本地配置与部分运行状态持久化

### 3.2 Electron 主进程层

主要位置：

- `ui/electron/main.ts`
- `ui/electron/preload.ts`

职责：

- 创建桌面窗口
- 提供文件系统与宿主能力
- 拉起和终止 Python 子进程
- 解析 Python 输出并转发给前端
- 提供环境检测、依赖修复、模型下载等宿主能力

### 3.3 Python 后端处理层

主要位置：

- `backend/main.py`
- `backend/action_handlers.py`
- `backend/tts_action_handlers.py`
- `backend/cli_options.py`
- `backend/asr.py`
- `backend/llm.py`
- `backend/tts.py`
- `backend/qwen_tts_service.py`
- `backend/alignment.py`

职责：

- 作为动作执行引擎承载 ASR、翻译、TTS、对齐、合成逻辑
- 基于 `--action` 分发不同操作
- 管理模型路径、运行环境和日志
- 执行单任务和批任务的完整媒体处理流程

### 3.4 本地资源与运行时层

主要位置：

- `python/`
- `models/`
- `backend/ffmpeg/`
- `output/`
- `logs/`
- `.cache/`

职责：

- 提供便携 Python 运行环境
- 提供 FFmpeg 能力
- 提供本地模型资源
- 保存缓存、日志、中间产物和最终输出

## 4. 当前运行模型

系统本质上是一个“三层协作、本地执行”的桌面应用：

1. 前端触发动作
2. Electron 将动作转成 IPC 调用
3. Electron 拉起 Python 后端
4. Python 按 action 执行业务
5. Python 通过 stdout/stderr 输出进度和结果
6. Electron 解析后转发前端
7. 前端更新界面与状态

这套模式的优点：

- 重型 AI 与媒体逻辑不压在前端
- Python 可以独立管理模型和多媒体依赖
- Electron 很适合承接本地桌面环境能力

这套模式的代价：

- 问题经常是跨层问题，不是单层问题
- stdout 实际上承担了协议角色
- 参数、默认值、日志风格容易在三层之间漂移

## 5. 主要业务流程

### 5.1 单文件工作流

主要由 `useVideoProject.ts` 和相关工作流 Hook 协调，核心步骤是：

1. 选择视频
2. 调用 ASR
3. 生成并编辑原字幕
4. 调用翻译
5. 生成单片段或批量配音
6. 对失败片段重试或兜底
7. 调用合成
8. 预览与输出结果

特点：

- 用户交互强
- 允许字幕人工校验
- 支持单段重试与局部修复

### 5.2 批处理工作流

主要由 `useBatchQueue.ts` 协调，核心步骤是：

1. 导入视频与字幕资源
2. 依据文件名建立视频、原字幕、翻译字幕映射
3. 创建每个任务的输出目录与临时目录
4. 在“完整流程模式”和“字幕直通模式”之间自动分支
5. 必要时翻译字幕
6. 批量生成配音
7. 对失败片段自动重试
8. 合成视频
9. 输出结果并清理中间工件

特点：

- 更强调任务编排与容错
- 更依赖参数一致性和状态恢复
- 更容易暴露跨层契约问题

## 6. 关键模块职责地图

### 前端核心

- `ui/src/App.tsx`
  - 顶层页面组合入口
  - 管理视图切换、布局、环境提示、批处理入口接线
- `ui/src/hooks/useVideoProject.ts`
  - 单文件工作流总协调
- `ui/src/hooks/useTranslationWorkflow.ts`
  - 翻译与重翻译
- `ui/src/hooks/useDubbingWorkflow.ts`
  - 配音生成、失败重试、合成前参数组织
- `ui/src/hooks/useBatchQueue.ts`
  - 批处理队列状态机与流程编排
- `ui/src/hooks/useSubtitleImport.ts`
  - 字幕导入与解码回退

### Electron 核心

- `ui/electron/main.ts`
  - 宿主总控
  - Python 进程管理
  - 输出解码与事件转发
- `ui/electron/preload.ts`
  - 向 Renderer 暴露宿主 API

### 后端核心

- `backend/main.py`
  - 后端总入口
- `backend/cli_options.py`
  - 参数定义与 kwargs 构建
- `backend/action_handlers.py`
  - 基础 action 分发
- `backend/tts_action_handlers.py`
  - TTS 相关 action 和重试细节
- `backend/llm.py`
  - 翻译模型封装
- `backend/asr.py`
  - ASR 相关处理
- `backend/alignment.py`
  - 时长对齐与音视频合成

## 7. 当前架构的优点

- 分层仍然基本成立，前端、宿主层、后端职责总体可识别
- 前端已经开始按工作流拆 Hook，方向正确
- 后端 action 分发已经成形，不再是纯单体脚本思维
- 批处理链路已具备工程化雏形，包括持久化、重试、清理、输出管理

## 8. 当前架构的主要问题

### 8.1 `backend/main.py` 仍然偏重

它同时承担：

- 运行时 bootstrap
- 日志重定向
- 模型路径设置
- 环境变量准备
- action 路由
- 主流程编排

这是当前后端扩展性的主要瓶颈之一。

### 8.2 前端深度感知后端参数

多个 Hook 直接组装 CLI 参数：

- `useVideoProject.ts`
- `useDubbingWorkflow.ts`
- `useBatchQueue.ts`

这会带来：

- 参数来源分散
- 默认值难统一
- 单流程和批处理容易行为漂移

### 8.3 stdout 同时承担日志和协议

当前前端依赖 Python 输出中的协议标记：

- `[PROGRESS]`
- `[PARTIAL]`
- `[DEPS_INSTALLING]`
- `[DEPS_DONE]`

这使得日志格式变动可能直接影响 UI 行为。

### 8.4 顶层页面编排仍偏重

`App.tsx` 当前仍承担较多职责：

- 视图切换
- 布局拖拽
- 弹窗管理
- 环境修复提示
- 批处理自动恢复接线

这说明前端顶层仍有进一步收敛空间。

### 8.5 参数和配置仍有漂移风险

当前可见问题包括：

- `localStorage` 在多个 Hook 中直接读取
- 模型默认值历史上出现过大小写不一致
- Electron 注入的 `model_dir` 和后端实际语义并不完全清晰

## 9. 扩展性判断

### 可以继续扩展的方向

- 新增 ASR 服务
- 新增 TTS 服务
- 新增批处理策略
- 新增输出工件管理
- 新增配置面板

### 扩展前应优先治理的点

1. 统一前端参数构建入口
2. 将协议日志和普通日志分层
3. 继续拆分 `backend/main.py`
4. 继续削薄 `App.tsx`
5. 收敛 localStorage key 与默认值定义
6. 收紧 Electron IPC 类型边界

## 10. 结论

当前 `VideoSyncMaster` 的整体架构是可用的，也具备继续扩展的基础，但还没有达到“稳定可持续扩展”的状态。

当前阶段最值得优先处理的，不是继续堆功能，而是：

1. 参数契约统一
2. 日志协议分层
3. 前后端总控文件削薄

总结判断：

> 当前架构“能跑且能扩”，但仍处于工程化收敛阶段。  
> 如果继续增加模型、流程和批处理能力，建议先治理跨层契约与日志协议，再继续堆叠功能。
