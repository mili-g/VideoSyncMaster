# VideoSyncMaster 架构与开发蓝图

## 1. 文档目标

本文档基于当前仓库的既有实现与《需求.md》中的业务目标，给出一套符合专业商业软件标准的开发蓝图，用于指导后续的架构演进、模块开发、质量治理与版本交付。

本文档不是泛泛的技术名词汇总，而是回答以下问题：

- 当前项目应该采用什么总体架构。
- 每个功能模块的职责边界应该如何划分。
- 每个模块更适合使用哪些设计模式。
- 桌面端、后端、模型运行时之间如何协同。
- 如何把现有代码逐步演进成稳定、可维护、可扩展的商业级产品。

---

## 2. 项目定位与产品目标

### 2.1 产品定位

VideoSyncMaster 是一款面向多语言视频教程场景的 AI 配音桌面应用，核心能力是将原始教学视频转换为目标语言配音视频，并尽量保证：

- 识别准确
- 分句自然
- 时间轴严格对齐
- 翻译适合朗读
- TTS 时长可控（利用现有的合成配置设置中的选项）
- 最终视频合成稳定（利用现有的合成配置设置中的选项）

### 2.2 典型用户

- 视频教程创作者
- 教培机构内容制作人员
- 多语言本地化团队
- 企业内部培训内容处理人员

### 2.3 业务目标

- 将单视频处理闭环做成稳定可重复执行的标准流水线。
- 支持批量任务、失败重试、会话恢复、日志追踪。
- 降低模型依赖冲突对用户的影响。
- 将“实验型 AI 工具”演进为“可交付桌面软件”。

### 2.4 非功能目标

- 稳定性：单步骤失败可定位、可恢复、可重试。
- 可维护性：模块边界清晰，避免继续把逻辑堆到 `backend/main.py`。
- 可扩展性：支持新增 ASR/TTS/翻译引擎而不破坏主流程。
- 可观测性：前后端事件、业务日志、错误分类一致。
- 可交付性：支持可移植 Python、离线模型、Windows 桌面安装包。

---

## 3. 当前仓库现状评估

### 3.1 现有技术栈

- 桌面容器：Electron
- 前端：React + TypeScript + Vite
- 后端：Python 3.11 可移植运行时
- 核心音视频工具：FFmpeg、Sox
- AI 侧：faster-whisper、Qwen ASR、IndexTTS、Qwen3-TTS、翻译 LLM

### 3.2 当前结构特点

仓库已经具备三层雏形：

1. `ui/`
   - 负责界面、工作台、批量任务、设置页、状态展示
2. `backend/`
   - 负责 AI 工作流、音视频处理、依赖检查、命令分发
3. `backend/vsm/`
   - 已出现应用层 / 领域层 / 基础设施层 / 接口层的分层尝试

### 3.3 当前主要优势

- 已具备从 ASR 到视频合成的基本闭环。
- 已有事件协议 `event_protocol.py`，适合作为统一进度总线。
- 已有错误模型、运行时配置、批量 TTS、会话恢复等基础能力。
- 已有 `ActionRouter` 和 `vsm` 目录，可作为后续重构支点。

### 3.4 当前主要问题

- `backend/main.py` 承担了过多职责：启动、环境准备、模型路由、业务编排、异常处理混杂在一起。
- 业务工作流仍偏“脚本式串行调用”，缺少清晰的用例服务层。
- ASR、翻译、分句、TTS、混音、导出之间的领域边界还不够稳定。
- 前端已形成页面与 Hook 分层，但状态流、任务状态机、错误口径仍可继续统一。
- 运行时隔离需求已在需求中提出，但当前仍以单后端进程承载大部分职责。
- 顶层目录混合了源码、第三方模型、可移植运行时、日志、输出产物、打包脚本和临时缓存，不符合专业项目的“源码与运行资产分离”原则。

结论：当前项目已经过了“从零到一”的实验阶段，适合进入“架构收敛与工程化治理”阶段。

---

## 4. 目标总体架构

建议采用 **桌面壳 + 前端工作台 + 工作流应用服务层 + 领域服务层 + 模型运行时适配层** 的分层架构。

### 4.1 目标架构图

```text
Electron Shell
  -> React Workbench (UI)
    -> IPC Bridge / Backend Worker Host
      -> Application Layer (Workflow Use Cases)
        -> Domain Layer (字幕、片段、配音任务、会话、策略)
          -> Infrastructure Layer
             - ASR Providers
             - TTS Providers
             - Translation Providers
             - FFmpeg / Sox / Filesystem
             - Session Store / Manifest / Logs
      -> Runtime Isolation Layer
         - ASR Runtime
         - TTS Runtime
         - Optional Translation Runtime
```

### 4.2 架构原则

- UI 不直接理解底层模型细节，只理解“任务”和“结果”。
- 工作流编排放在应用层，不放在 UI，也不散落在脚本函数里。
- 领域对象只表达业务概念，不直接依赖具体模型 SDK。
- 基础设施层负责“怎么调用”，领域层负责“为什么这样调用”。
- 模型运行时采用隔离思路，优先通过子进程或独立 worker 解决依赖冲突。

---

## 5. 分层设计

### 5.1 展示层（Presentation Layer）

范围：

- `ui/src/pages`
- `ui/src/components`
- `ui/src/hooks`
- Electron preload / IPC

职责：

- 用户输入与配置收集
- 任务发起、取消、重试
- 进度可视化
- 结果展示与导出
- 错误提示、恢复提示

不应承担：

- 业务编排细节
- 模型参数转换逻辑
- 音视频处理规则

建议模式：

- `MVVM / ViewModel Hook`
  - 适合 React Hook 组织复杂页面状态
  - 例如 `useDubbingWorkflow.ts` 已接近 ViewModel 角色
- `Facade`
  - 用统一的 `window.api` / service 层隐藏 IPC 与后端调用细节
- `State Machine`
  - 用于批量任务状态、单视频工作流状态、恢复状态

### 5.2 应用层（Application Layer）

建议落位：

- `backend/vsm/app/workflows`
- 后续新增 `backend/vsm/app/use_cases`

职责：

- 编排完整业务用例
- 组织跨领域服务协作
- 发布进度事件
- 管理步骤级异常与补偿
- 输出统一 DTO

典型用例：

- `CreateProjectSession`
- `RunAsrWorkflow`
- `RunSubtitleSegmentationWorkflow`
- `RunTranslationWorkflow`
- `RunBatchTtsWorkflow`
- `MergeDubbedVideoWorkflow`
- `ResumeInterruptedSession`
- `RetryFailedSegmentsWorkflow`

建议模式：

- `Application Service`
  - 每个用例一个服务类，代替继续扩展 `dispatch_basic_action`
- `Template Method`
  - 抽取统一工作流骨架：准备 -> 执行 -> 校验 -> 持久化 -> 事件上报
- `Command`
  - 把“执行一个动作”封装成可记录、可重放、可取消的命令
- `Saga / Process Manager`
  - 用于长流程任务的步骤推进、失败恢复、补偿处理

### 5.3 领域层（Domain Layer）

建议围绕以下核心领域建模：

- 视频项目 `VideoProject`
- 字幕片段 `SubtitleSegment`
- 词级时间片 `WordTimestamp`
- 翻译片段 `TranslatedSegment`
- 配音片段 `DubSegment`
- 任务会话 `ProcessingSession`
- 运行策略 `ProcessingStrategy`

职责：

- 定义核心业务规则
- 保证片段时间窗与文本绑定关系
- 定义时长约束、片段合法性、重试条件
- 为应用层提供纯业务判断

建议模式：

- `Domain Model`
  - 将片段、会话、任务、能力作为明确模型，而不是散落字典
- `Value Object`
  - 例如语言、时间窗、音频路径、策略参数
- `Strategy`
  - 对齐策略、分句策略、混音策略、时长补偿策略
- `Specification`
  - 判断“片段是否可进入 TTS”“片段是否需要重试”“字幕是否合法”

### 5.4 基础设施层（Infrastructure Layer）

范围：

- ASR/TTS/翻译模型适配
- FFmpeg / Sox 调用
- 文件系统读写
- 日志、事件、错误序列化
- manifest 与缓存目录管理

职责：

- 把外部工具和 SDK 封装为稳定接口
- 隔离第三方依赖差异
- 对应用层提供统一调用契约

建议模式：

- `Adapter`
  - 统一各种 ASR/TTS/翻译引擎调用方式
- `Factory`
  - 根据配置创建 provider / runtime / strategy
- `Repository`
  - 管理会话清单、项目产物、模型配置
- `Anti-Corruption Layer`
  - 防止第三方返回结构直接污染内部领域模型

---

## 6. 核心业务模块设计

## 6.1 项目会话与工作空间模块

职责：

- 为每个视频建立唯一 session
- 管理缓存目录、音频目录、临时文件、最终产物
- 记录可恢复状态

输入：

- 原视频路径
- 输出目录

输出：

- `SessionManifest`
- 工作目录结构

建议模式：

- `Repository`：读写 manifest
- `Factory`：创建 session 路径上下文
- `Memento`：保存处理中间状态，支持恢复

关键规则：

- 所有中间产物必须归档到 session 目录
- 所有阶段变更必须更新 manifest
- 恢复逻辑必须依赖 manifest，不依赖临时内存状态

## 6.2 媒体预处理模块

职责：

- 视频探测
- 音频抽取
- 响度标准化
- 可选人声分离
- 参考音频准备

建议模式：

- `Facade`：统一封装 FFmpeg/Sox 操作
- `Pipeline`：预处理步骤串联
- `Builder`：构造复杂转码命令

关键规则：

- 预处理结果必须附带媒体元数据
- 音频采样率、声道、时长必须统一口径
- 所有外部命令失败必须转换为标准错误对象

## 6.3 ASR 模块

职责：

- 调度不同 ASR Provider
- 输出句级与词级时间戳
- 管理分块识别与语言配置

建议模式：

- `Strategy`：faster-whisper、Qwen、GLM、云端 API 作为不同策略
- `Registry`：当前 `AsrRegistry` 已是良好起点
- `Adapter`：把不同引擎输出映射到统一 `AsrTaskResult`
- `Health Check` 模式：启动前校验 provider 是否可用

建议演进：

- 扩展 `vsm/domain/recognition` 为完整的 ASR 领域
- 把 `run_asr` 逐步迁移为 `AsrApplicationService`
- 所有 provider 返回统一 `segments + words + metadata`

## 6.4 字幕清洗与语义分句模块

职责：

- 去口水词
- 句长裁剪
- 专业术语保护
- 重建适合翻译和 TTS 的片段

建议模式：

- `Chain of Responsibility`
  - 清洗规则按顺序执行：去噪 -> 术语保护 -> 长句拆分 -> 合并修复
- `Strategy`
  - 中英文、小语种采用不同分句策略
- `Rule Engine`
  - 把可配置规则从硬编码中抽离

关键规则：

- 分句必须保留原始时间窗映射关系
- 不能用全文翻译替代片段翻译
- 每个片段要满足可朗读、可对齐、可重试

## 6.5 时间轴对齐模块

职责：

- 基于词级时间戳重建句级时间窗
- 校验片段边界合理性
- 为后续 TTS 提供可用时长约束

建议模式：

- `Domain Service`
  - 对齐逻辑是核心业务规则，不应只是工具函数
- `Policy`
  - 不同对齐误差容忍策略
- `Validator`
  - 检查时间重叠、负时长、超短片段、超长片段

关键规则：

- 句子起点 = 首词起点
- 句子终点 = 末词终点
- 片段时长是后续 TTS 的硬约束输入

## 6.6 翻译模块

职责：

- 执行片段级翻译
- 控制教学场景下的意译风格
- 保留术语准确性
- 控制句长，适配朗读

建议模式：

- `Strategy`
  - 本地模型、外部 API、不同提示词模板作为不同策略
- `Prompt Template`
  - 统一翻译约束模板
- `Batching Service`
  - 对支持批量的引擎进行批处理编排

关键规则：

- 翻译输入单位必须是时间窗片段，不是全文
- 翻译结果必须可回写到对应 segment
- 翻译失败要返回可重试粒度到“片段级”

## 6.7 TTS 模块

职责：

- 选择 TTS 引擎
- 执行单条或批量合成
- 控制目标时长、参考音频、音色策略

建议模式：

- `Strategy`
  - IndexTTS、Qwen3-TTS、后续 XTTS 均为不同策略
- `Factory`
  - 根据配置创建 runner
- `Retry`
  - 对片段级失败进行幂等重试
- `Bulkhead`
  - 控制批量并发，避免显存被打爆

关键规则：

- TTS 结果必须记录 `audio_path`、`duration`、`success`、`error`
- 时长超标触发自动补偿或对齐策略
- 单段失败不应导致整批直接失去所有上下文

## 6.8 音频补偿与混音模块

职责：

（利用现有的合成配置设置中的选项）

- 对超时长配音片段进行压缩、对齐或补偿
- 混合背景音与配音轨道
- 生成最终音轨

建议模式：

- `Strategy`
  - `frame_blend`、`freeze_frame`、`rife`、纯音频对齐等策略
- `Policy Object`
  - 音量混合、淡入淡出、背景保留比例

关键规则：

- 补偿策略与视频策略要解耦
- 所有混音参数必须可配置、可追踪
- 最终合成前应做素材完整性校验

## 6.9 视频合成与导出模块

职责：

- 将新音频片段按时间窗合并回视频
- 导出最终视频和字幕产物

建议模式：

- `Facade`
  - 屏蔽 FFmpeg 调用细节
- `Builder`
  - 生成导出命令
- `Post-Processor`
  - 统一做字幕导出、结果清理、产物登记

## 6.10 批量任务模块

职责：

- 管理多视频队列
- 控制排队、执行、暂停、取消、恢复
- 汇总结果与失败原因

建议模式：

- `Queue + State Machine`
- `Command`
- `Observer`
  - 用于 UI 订阅任务状态

建议状态：

- pending
- preparing
- running
- partially_failed
- failed
- canceled
- completed

---

## 7. 推荐设计模式总表

| 模块 | 推荐模式 | 目的 |
| --- | --- | --- |
| 前端复杂页面 | MVVM / Hook ViewModel | 降低组件与流程耦合 |
| 后端动作分发 | Command + Router | 统一入口，利于扩展 |
| ASR/TTS/翻译引擎 | Strategy + Adapter + Factory | 支持多引擎切换 |
| 长流程任务 | Template Method + Saga | 统一阶段编排与恢复 |
| 文本清洗 | Chain of Responsibility | 便于叠加规则 |
| 会话恢复 | Memento + Repository | 支持中断恢复 |
| 事件通知 | Observer / Event Bus | 统一进度和错误传播 |
| 外部工具集成 | Facade | 隐藏 FFmpeg/Sox 复杂度 |
| 参数与规则 | Policy Object / Specification | 避免硬编码判断扩散 |

---

## 8. 建议的数据与对象模型

建议优先把现在大量 `dict` 结构逐步收敛为明确 DTO / Entity。

### 8.1 核心对象

- `VideoProject`
  - project_id
  - source_path
  - output_dir
  - created_at

- `ProcessingSession`
  - session_key
  - phase
  - current_stage
  - recoverable
  - artifacts
  - last_error

- `SubtitleSegment`
  - index
  - start
  - end
  - text
  - words
  - source_language

- `TranslatedSegment`
  - index
  - source_text
  - translated_text
  - target_language
  - duration_budget

- `DubSegment`
  - index
  - audio_path
  - duration
  - status
  - error_info

### 8.2 状态对象建议

- `WorkflowPhase`
- `SegmentProcessingStatus`
- `ProviderCapability`
- `RuntimeHealth`
- `ErrorInfo`

这样做的价值是：

- 统一前后端字段口径
- 降低拼字段导致的隐式错误
- 让恢复逻辑、重试逻辑、批量逻辑更稳定

---

## 9. 前后端协同设计

### 9.1 通信建议

当前模式适合继续保留：

- Electron Renderer
- preload 暴露安全 API
- 后端 worker 子进程
- stdout 事件流 + 最终 JSON 结果

这是一个适合桌面工具的轻量方案，建议继续强化，而不是过早引入本地 HTTP 服务。

### 9.2 协议建议

现有 `event_protocol.py` 已经是核心资产，建议把所有运行中反馈统一收敛为：

- `stage`
- `progress`
- `issue`
- `partial_result`
- `result`

建议补充：

- `trace_id`
- `session_key`
- `task_id`
- `provider_id`
- `step_cost_ms`

### 9.3 错误返回标准

所有后端错误统一输出：

- code
- message
- category
- stage
- retryable
- detail
- suggestion

前端只消费统一错误模型，不直接解析第三方异常字符串。

---

## 10. 运行时与依赖隔离设计

这是本项目能否走向商业化的关键。

### 10.1 目标

- 避免 ASR、TTS、翻译模型依赖互相污染
- 降低 GPU / CUDA / transformers 版本冲突
- 提高异常隔离能力

### 10.2 建议方案

#### 方案 A：单后端主控 + 分 Runtime 子进程

- 主控进程：调度、日志、工作流编排
- ASR Runtime：独立子进程
- TTS Runtime：独立子进程
- 可选 Translation Runtime：按需独立

适合当前项目，改造成本可控。

#### 方案 B：完全服务化

- 每类模型独立为本地 RPC 服务

不建议当前阶段直接采用，复杂度偏高。

### 10.3 当前推荐结论

先落地方案 A：

- `backend/main.py` 保留为主控 worker
- `backend/runners/asr_runtime` 继续发展成标准 ASR runtime
- 新增 `backend/runners/tts_runtime`
- 后续视翻译模型复杂度决定是否增加 `translation_runtime`

建议模式：

- `Broker / Mediator`
  - 主控进程协调不同 runtime
- `Circuit Breaker`
  - 某类 runtime 连续失败时快速失败并提示用户

---

## 11. 目录重构建议

建议目标目录：

```text
VideoSyncMaster/
  apps/
    desktop/
      ui/
      electron/
  services/
    media_pipeline/
      bootstrap/
      app/
      domain/
      infra/
      interfaces/
      runners/
  resources/
    ffmpeg/
    sox/
    icons/
    installers/
  runtime/
    python/
  models/
    asr/
    tts/
    translation/
    shared/
  storage/
    output/
    logs/
    cache/
  scripts/
    dev/
    build/
    release/
  docs/
  tests/
    unit/
    integration/
    e2e/
  package.json
  requirements.txt
```

当前 `backend/vsm/` 已经可以作为 `services/media_pipeline/` 的内核来源，建议后续逐步把 `backend/*.py` 的核心逻辑迁移进去。

---

## 12. 仓库物理目录重构规划

这一部分专门解决“文件结构混乱、不专业”的问题。

### 12.1 当前顶层目录问题

当前顶层同时存在这些不同性质的内容：

- 源码：`backend`、`ui`
- 运行时：`python`
- 模型：`models`、`Qwen3-ASR`
- 资源：`resource`、`asset`
- 运行产物：`logs`、`output`
- 临时缓存：`.cache`、`.env_cache`、`__pycache__`
- 打包脚本：`package_app.py`、`patch_installer.iss`、`start.bat`

这会带来几个问题：

- 新人看目录时无法判断哪些是源码，哪些是部署资产。
- Git 仓库会逐渐被环境和产物污染。
- 打包、运行、开发、调试路径容易混淆。
- 后续做自动化构建、CI、版本发布时很难标准化。

### 12.2 目标顶层目录标准

建议把顶层目录按“职责”拆成 8 类：

1. `apps/`
   - 用户直接交互的应用入口
   - 当前应承接 Electron + React 桌面端

2. `services/`
   - 核心业务与处理服务
   - 当前应承接 Python 媒体流水线后端

3. `resources/`
   - 打包时要带走的静态资源
   - 如图标、FFmpeg、Sox、安装器模板

4. `runtime/`
   - 可移植 Python 或其他运行时
   - 与源码隔离

5. `models/`
   - 本地模型资产
   - 必须继续分类管理，不能平铺

6. `storage/`
   - 运行产物和本地缓存
   - 日志、输出、缓存统一归档

7. `scripts/`
   - 启动、构建、发布、诊断脚本

8. `docs/`、`tests/`
   - 文档与测试分开治理

### 12.3 建议目标目录树

```text
VideoSyncMaster/
  apps/
    desktop/
      electron/
      ui/
  services/
    media_pipeline/
      bootstrap/
      app/
      domain/
      infra/
      interfaces/
      runners/
  resources/
    media_tools/
      ffmpeg/
      sox/
    branding/
      icons/
    packaging/
      installer/
  runtime/
    python/
  models/
    asr/
      qwen3/
      whisper/
    tts/
      indextts/
      qwen3_tts/
    translation/
    shared/
  storage/
    logs/
    output/
    cache/
    temp/
  scripts/
    dev/
    build/
    release/
    diagnostics/
  docs/
  tests/
  .gitignore
  package.json
  requirements.txt
```

### 12.4 现有目录到目标目录的映射建议

| 当前目录/文件 | 建议目标位置 | 说明 |
| --- | --- | --- |
| `ui/` | `apps/desktop/ui/` | 前端源码 |
| `ui/electron/` | `apps/desktop/electron/` 或保留在 `apps/desktop/ui/electron/` | 视前端工程是否继续合并管理 |
| `backend/` | `services/media_pipeline/` | Python 主服务源码 |
| `backend/ffmpeg/` | `resources/media_tools/ffmpeg/` | 从源码目录移出 |
| `backend/sox/` | `resources/media_tools/sox/` | 从源码目录移出 |
| `python/` | `runtime/python/` | 运行时资产，不属于源码 |
| `models/` | `models/tts/indextts/` 等子目录 | 继续细分 |
| `Qwen3-ASR/` | `models/asr/qwen3/` 或 `third_party/qwen3_asr/` | 若是模型资产放 `models`，若含源码放 `third_party` |
| `resource/` | `resources/` | 统一命名，避免单复数混乱 |
| `asset/` | `resources/branding/` 或 `apps/desktop/ui/src/assets/` | 按是否参与构建决定 |
| `logs/` | `storage/logs/` | 运行产物 |
| `output/` | `storage/output/` | 导出产物 |
| `.cache/` | `storage/cache/` | 本地缓存 |
| `.env_cache/` | `storage/cache/env/` | 环境缓存 |
| `package_app.py` | `scripts/release/package_app.py` | 发布脚本 |
| `patch_installer.iss` | `resources/packaging/installer/patch_installer.iss` | 安装器资源 |
| `start.bat` | `scripts/dev/start.bat` | 开发入口脚本 |
| `VideoSync.vbs` | `scripts/dev/VideoSync.vbs` | 桌面启动脚本 |
| `VC_redist.x64.exe` | `resources/packaging/runtime/VC_redist.x64.exe` | 打包依赖，不应放根目录 |

### 12.5 顶层目录治理规则

后续应明确执行这些规则：

- 根目录只保留项目说明、依赖声明、少量入口文件。
- 源码目录内不得混放模型、FFmpeg、日志和输出结果。
- 运行时目录不得放业务代码。
- `storage/` 默认加入 `.gitignore`，除非明确需要提交示例产物。
- `models/` 需要分“源码依赖”和“二进制模型资产”两类管理。
- 临时缓存和 `__pycache__` 不得作为项目结构的一部分存在于设计文档之外。

### 12.6 最小风险迁移顺序

不建议一次性大搬家，建议按下面顺序迁移：

#### 第一步：先搬运行产物和资源

- `logs -> storage/logs`
- `output -> storage/output`
- `.cache -> storage/cache`
- `backend/ffmpeg -> resources/media_tools/ffmpeg`
- `backend/sox -> resources/media_tools/sox`

这是最低风险的一步，因为对业务代码影响最小。

#### 第二步：搬运行时与模型

- `python -> runtime/python`
- `Qwen3-ASR -> models/asr/qwen3` 或 `third_party/qwen3_asr`
- 对 `models/` 内部再做细分

这一步要同步修改路径解析逻辑和打包脚本。

#### 第三步：搬应用源码

- `ui -> apps/desktop/ui`
- `backend -> services/media_pipeline`

这一步影响 import、打包和启动路径，必须在路径适配完成后执行。

#### 第四步：补齐脚本和文档入口

- 建立 `scripts/dev`
- 建立 `scripts/release`
- 更新 README、启动脚本、打包脚本、Electron 后端路径引用

### 12.7 目录重构时必须同步修改的代码点

目录迁移不是简单移动文件，至少要同步检查这些位置：

- Python 启动路径推导逻辑
- `APP_ROOT`、`CURRENT_DIR`、模型目录搜索逻辑
- FFmpeg/Sox 路径装配逻辑
- Electron 启动后端脚本路径
- preload API 中的文件读写基准目录
- 前端保存输出路径与 session 路径规则
- 打包脚本中的资源拷贝路径

### 12.8 仓库结构最终要求

专业仓库至少要满足以下视觉和工程特征：

- 根目录一眼能分清源码、资源、运行时、模型、输出。
- 任何人首次进入仓库，都能知道从哪里启动、哪里开发、哪里打包。
- 源码目录不再包含大体积第三方工具和运行产物。
- 目录命名统一，避免同时出现 `asset` / `resource` / `resources` 这种并行概念。
- 后续 CI、打包、安装器、自动更新都能基于这套结构继续演进。

---

## 13. 质量标准

### 12.1 代码标准

- 业务流程不得继续堆积到单文件超长函数
- 外部依赖调用必须有统一错误包装
- 所有 DTO / Entity 明确字段，不鼓励裸字典跨层传递
- 关键流程必须有可读日志

### 12.2 测试标准

测试建议分四层：

1. 领域单元测试
   - 分句规则
   - 时间轴对齐
   - 片段合法性校验
2. 应用层集成测试
   - 单视频完整工作流
   - 批量任务恢复
   - 失败片段重试
3. 基础设施适配测试
   - provider 健康检查
   - runtime 启动检查
   - FFmpeg 依赖检查
4. UI 流程测试
   - 任务创建
   - 状态展示
   - 错误提示
   - 会话恢复

### 12.3 日志标准

日志至少分为：

- 启动日志
- 业务日志
- 进度事件日志
- 第三方依赖日志
- 错误日志
- 审计日志（删除、覆盖、导出、清理）

---

## 14. 商业软件级非功能设计

### 13.1 稳定性

- 所有长任务支持取消
- 所有可重试步骤支持片段级重试
- 所有关键产物支持断点恢复

### 13.2 性能

- 批量任务控制并发
- 模型预热与懒加载结合
- 减少重复加载大型模型

### 13.3 可观测性

- 全链路 trace_id
- 关键步骤耗时统计
- runtime 健康状态上报

### 13.4 安全与交付

- preload 暴露最小必要 API
- 文件路径白名单与存在性校验
- 输出目录和删除动作必须审慎
- 安装包需明确依赖与模型目录约束

---

## 15. 建议实施路线

### 阶段一：结构收敛

目标：

- 稳住当前可运行能力
- 减少继续膨胀

任务：

- 把 `backend/main.py` 中工作流拆分到 `vsm/app/use_cases`
- 统一 DTO 与错误模型
- 为 TTS runtime 建立独立 runner
- 建立 `storage/`、`resources/`、`runtime/` 的物理目录并完成低风险迁移

### 阶段二：领域建模

目标：

- 固化字幕、翻译、配音、会话模型

任务：

- 引入 `SubtitleSegment`、`TranslatedSegment`、`DubSegment` 等实体
- 把分句、对齐、补偿策略收敛为领域服务
- 抽离策略接口
- 完成 `backend -> services/media_pipeline` 的目标结构映射设计

### 阶段三：运行时隔离

目标：

- 降低依赖冲突和显存争用

任务：

- ASR/TTS 子进程化
- provider 健康检查
- runtime 池化与故障恢复
- 完成 `python/` 与模型目录的新路径接入

### 阶段四：工程治理

目标：

- 达到可持续发布状态

任务：

- 增加测试矩阵
- 增加日志和指标口径
- 梳理打包、版本、回滚和问题排查文档
- 完成脚本、安装器、资源、文档入口的目录标准化

---

## 16. 优先级最高的架构改造项

按商业价值和风险排序，建议优先做以下 8 项：

1. 拆分 `backend/main.py`，建立明确用例服务层。
2. 建立统一的 `Segment` / `Session` / `ErrorInfo` 数据模型。
3. 将 ASR / TTS provider 彻底适配成统一接口。
4. 把仓库顶层目录按源码、资源、运行时、模型、产物重新分组。
5. 把时间轴对齐逻辑提升为领域核心服务。
6. 建立 TTS runtime 独立子进程。
7. 统一批量任务状态机与恢复机制。
8. 统一事件协议与前端错误呈现口径。
9. 补齐测试、日志、打包交付标准。

---

## 17. 结论

VideoSyncMaster 当前最合适的路线不是推倒重写，而是基于现有能力做一次明确的工程化收敛：

- 前端继续保留 React Hook 工作流组织方式，但引入更清晰的状态机与服务边界。
- 后端以 `vsm` 目录为核心，逐步从脚本式编排演进为应用层 + 领域层 + 基础设施层架构。
- ASR、翻译、TTS、混音、导出应全部纳入统一工作流模型和统一错误口径。
- 运行时隔离与会话恢复是本项目商业化可用性的决定性能力。
- 仓库目录必须从“实验堆放式”演进为“源码、资源、运行时、模型、产物分离式”。

最终目标不是“再加几个模型”，而是把这套多语言视频配音流水线做成一个稳定、可交付、可持续迭代的桌面软件系统。

---

## 18. 对应仓库建议文档关系

建议后续在仓库中形成如下文档体系：

- `docs/VideoSyncMaster-架构与开发蓝图.md`
- `docs/VideoSyncMaster-模块详细设计.md`
- `docs/VideoSyncMaster-运行时隔离设计.md`
- `docs/VideoSyncMaster-错误码与事件协议.md`
- `docs/VideoSyncMaster-测试与发布规范.md`

本文档作为总纲，后续详细设计文档以此为准展开。
