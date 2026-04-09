# VideoSyncMaster 后期优化审核清单 V2

## 1. 文档目的

本文档基于 [PROJECT_ANALYSIS_V2.md](/C:/Users/MI/Downloads/VideoSyncMaster/PROJECT_ANALYSIS_V2.md) 的深入分析结果，将后期优化建议展开为可审核、可排期、可落地的实施方案。

这份文档重点回答 5 个问题：

1. 每一项优化具体改什么。
2. 预计会影响哪些文件和模块。
3. 为什么要这样改，根因是什么。
4. 对现有单文件流程、批量流程、预识别字幕流程会产生什么影响。
5. 如何分阶段推进，避免一次性重构把现有可用能力打断。

适用场景：

1. 作为后续开发前的审核依据。
2. 作为里程碑拆分和任务落地的输入。
3. 作为回归测试与验收 checklist 的基础文档。

## 2. 总体实施原则

后续优化建议遵循以下原则：

1. 先治理运行时与版本契约，再治理前后端协议，再治理模块边界。
2. 不做一次性重写，采用兼容式替换，优先降低线上流程风险。
3. 优先收口高风险单点和隐式耦合，而不是先做表层 UI 重构。
4. 每个阶段都必须保证单文件流程、批量流程、预识别字幕流程可运行。
5. 涉及 Qwen 相关能力时，必须以模型上游真实依赖和本地验证结果为准，不能主观合并版本。

## 3. 优化路线总览

建议按 6 个阶段推进：

1. 阶段 A：切换机制加固与版本契约治理
2. 阶段 B：后端事件协议结构化
3. 阶段 C：前端参数构建统一
4. 阶段 D：模型策略层正规化
5. 阶段 E：主入口拆分与模块边界治理
6. 阶段 F：测试、验收与发布治理

---

## 4. 阶段 A：切换机制加固与版本契约治理

## 4.1 目标

彻底解决以下问题：

1. `Qwen3-ASR`、`Qwen3-TTS`、`WhisperX`、`Index-TTS` 的依赖版本存在真实冲突。
2. [requirements.txt](/C:/Users/MI/Downloads/VideoSyncMaster/requirements.txt)、[backend/dependency_manager.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/dependency_manager.py)、[Qwen3-ASR/pyproject.toml](/C:/Users/MI/Downloads/VideoSyncMaster/Qwen3-ASR/pyproject.toml)、[backend/Qwen3-TTS/pyproject.toml](/C:/Users/MI/Downloads/VideoSyncMaster/backend/Qwen3-TTS/pyproject.toml) 当前版本口径不一致。
3. 现有 `fix-python-env` 修复的是“当前环境”，不等于“目标功能真正需要的运行时”。
4. 当前通过热切 `site-packages` 来切换 `transformers/tokenizers/accelerate`，虽然项目已能运行，但仍存在缓存污染、半切换、状态不透明、失败后缺少回滚等风险。

## 4.2 经核实后的约束结论

经对本仓库与上游声明核对，当前必须承认下面这些约束是真实存在的：

1. [Qwen3-ASR/pyproject.toml](/C:/Users/MI/Downloads/VideoSyncMaster/Qwen3-ASR/pyproject.toml) 声明：
   - `transformers>=4.57.6`
   - `accelerate==1.12.0`
2. [backend/Qwen3-TTS/pyproject.toml](/C:/Users/MI/Downloads/VideoSyncMaster/backend/Qwen3-TTS/pyproject.toml) 声明：
   - `transformers==4.57.3`
   - `accelerate==1.12.0`
3. [requirements.txt](/C:/Users/MI/Downloads/VideoSyncMaster/requirements.txt) 当前基础环境仍是：
   - `transformers==4.52.1`
   - `accelerate==1.8.1`
4. [backend/dependency_manager.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/dependency_manager.py) 当前本地策略仍把 Qwen 侧粗略归并为一个 profile，这与 `Qwen3-ASR` 和 `Qwen3-TTS` 的上游契约并不完全一致。

结论：

1. 不能把 `Qwen3-ASR` 与 `Qwen3-TTS` 直接写成“默认共享同一套固定运行时”。
2. 更不能在方案文档里主观把两者统一到一个自定版本，例如直接写成统一使用 `transformers 4.57.6`。
3. 现阶段不把“多运行时拆分”作为主方案，因为当前项目已经围绕单环境切换机制跑通，强行改架构会引入更大改造面。
4. 合理方向应是保留当前切换方法，但把切换动作、版本校验、缓存完整性、失败回滚、用户提示全部补齐，做到更稳、更透明、更可恢复。

## 4.3 修正后的方案

保留当前“单 Python 环境 + 缓存目录切换关键包”的方法，不改主运行架构，只做稳态加固。

本阶段目标不是改成多运行时，而是把当前切换机制提升到工程可控状态：

1. 保留现有 `.env_cache` + `site-packages` 切换路径。
2. 把“切换成功”从经验判断改为显式校验。
3. 把“切换失败后环境可能半残”改为自动回滚或显式阻断。
4. 把“当前到底处于哪个版本族”变成 UI 与日志可见信息。
5. 把 `Qwen3-ASR` 和 `Qwen3-TTS` 的版本约束明确记录为切换策略输入，而不是模糊地共用一个口径。

允许的后续优化路径：

1. 先把当前切换机制做稳。
2. 在现有机制足够稳定前，不推进多环境拆分。
3. 即使未来评估多环境，也必须在当前方案充分验证后另开议题，不纳入本轮主优化路线。

## 4.4 具体改动内容

### 4.4.1 新增切换元数据配置

建议新增：

- `env_profiles/switch_profiles.json`

这不是多运行时配置，而是当前切换机制的“版本契约表”与“校验规则表”。

示例结构：

```json
{
  "profiles": {
    "index": {
      "transformers": "4.52.1",
      "accelerate": "1.8.1",
      "packages": ["transformers", "tokenizers", "accelerate"],
      "services": ["whisperx", "indextts", "translate_local"],
      "source_of_truth": ["requirements.txt"]
    },
    "qwen_tts": {
      "transformers": "4.57.3",
      "accelerate": "1.12.0",
      "packages": ["transformers", "tokenizers", "accelerate"],
      "services": ["qwen_tts"],
      "source_of_truth": ["backend/Qwen3-TTS/pyproject.toml"]
    },
    "qwen_asr": {
      "transformers": ">=4.57.6",
      "accelerate": "1.12.0",
      "packages": ["transformers", "tokenizers", "accelerate"],
      "services": ["qwen_asr"],
      "source_of_truth": ["Qwen3-ASR/pyproject.toml"]
    }
  }
}
```

注意：

1. 这里的 `profile` 表示切换目标，不等于独立虚拟环境。
2. `qwen_asr` 不应在方案阶段主观收敛为某个固定小版本，除非本地验证已经明确落在具体版本并有测试记录。
3. 如果当前代码仍需要 `PROFILE_QWEN3 = 4.57.3` 维持兼容，则文档必须明确标注这是“现行实现”，不是“上游完整契约已满足”。

### 4.4.2 加固 [backend/dependency_manager.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/dependency_manager.py)

当前问题：

1. 该文件把“环境切换”实现成 `site-packages` 目录移动。
2. `PROFILE_QWEN3 = 4.57.3` 会让 Qwen ASR 跟着 Qwen TTS 走，和上游契约不完全一致。
3. 运行时选择、版本声明、安装修复、健康检查目前都混在一起。

建议保留它作为切换核心，但补强以下能力：

1. 切换前快照
   - 记录当前 `transformers/tokenizers/accelerate` 版本与路径
2. 切换后校验
   - 校验目录完整性
   - 校验 `dist-info` 是否匹配
   - 校验 `importlib.metadata.version()` 是否满足目标约束
3. 失败自动回滚
   - 如果恢复目标包失败，自动还原切换前状态
4. 缓存健康检查
   - 切换前判断 `.env_cache/v_xxx` 是否缺文件、空目录、残缺目录
5. 显式状态输出
   - 输出“当前激活 profile”“来源版本”“回滚结果”“修复建议”

建议新增辅助模块：

1. `backend/switch_profile_registry.py`
   - 维护服务到切换目标的映射
2. `backend/switch_validator.py`
   - 提供版本约束检查、缓存完整性检查、切换后验收
3. `backend/switch_rollback.py`
   - 封装失败回滚流程

### 4.4.3 修改 Electron 后端启动逻辑

当前文件：

- [ui/electron/main.ts](/C:/Users/MI/Downloads/VideoSyncMaster/ui/electron/main.ts)

建议修改为：

1. `run-backend` 启动前先根据 `action` 解析本次应切到哪个 profile。
2. 切换前先检查目标缓存是否存在、是否完整。
3. 切换成功后把当前激活 profile 返回给前端。
4. 切换失败时直接返回结构化错误，提示用户修复缓存或重新安装，而不是继续启动导致后端半残。

建议新增函数：

1. `resolveBackendProfile(action, args)`
2. `validateSwitchTarget(profileName)`
3. `reportActiveSwitchProfile()`

### 4.4.4 修改 `fix-python-env`

当前问题：

1. 当前修复入口对“切换缓存损坏”和“基础依赖缺失”区分不够明确。
2. 用户不清楚修复的是基础环境、Qwen 缓存，还是全部切换缓存。
3. 修复后缺少再次验收，用户只能靠再次运行功能来判断是否成功。

建议改成按切换目标修复：

1. `fix-python-env --profile index`
2. `fix-python-env --profile qwen`
3. `fix-python-env --profile all`
4. `fix-python-env --rebuild-cache qwen`

UI 提示同步改成明确文案：

1. 修复基础版本缓存
2. 修复 Qwen 切换缓存
3. 重建全部切换缓存
4. 修复后自动验收当前版本状态

### 4.4.5 对齐版本源

必须统一并收口以下文件中的“版本口径来源”，但这里的“统一”不是统一成一个版本，也不是改成多环境，而是统一成“同一套切换契约规则”：

- [requirements.txt](/C:/Users/MI/Downloads/VideoSyncMaster/requirements.txt)
- [backend/dependency_manager.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/dependency_manager.py)
- [Qwen3-ASR/pyproject.toml](/C:/Users/MI/Downloads/VideoSyncMaster/Qwen3-ASR/pyproject.toml)
- [backend/Qwen3-TTS/pyproject.toml](/C:/Users/MI/Downloads/VideoSyncMaster/backend/Qwen3-TTS/pyproject.toml)

审核要求：

1. 基础链路按基础 requirements 管。
2. `Qwen3-TTS` 按自己的上游依赖声明管。
3. `Qwen3-ASR` 按自己的上游依赖声明管。
4. 当前切换实现如果暂时复用一个 `PROFILE_QWEN3`，必须在代码和文档中明确风险与适用范围。
5. 不新增多环境架构，不改变现有能跑通的主路径，只提升版本切换的正确性和健壮性。

## 4.5 影响文件

建议改动文件：

- [backend/dependency_manager.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/dependency_manager.py)
- [backend/main.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/main.py)
- [backend/qwen_asr_service.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/qwen_asr_service.py)
- [backend/qwen_tts_service.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/qwen_tts_service.py)
- [backend/tts.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/tts.py)
- [ui/electron/main.ts](/C:/Users/MI/Downloads/VideoSyncMaster/ui/electron/main.ts)
- [requirements.txt](/C:/Users/MI/Downloads/VideoSyncMaster/requirements.txt)

建议新增文件：

- `env_profiles/switch_profiles.json`
- `backend/switch_profile_registry.py`
- `backend/switch_validator.py`
- `backend/switch_rollback.py`

## 4.6 风险与兼容策略

风险：

1. 现有切换缓存历史数据可能已经存在不完整目录。
2. 如果没有回滚，切换中断后会把当前环境打成半残。
3. 上游依赖要求与当前实现存在差距时，局部能力可能仍需保守兼容。
4. 加入更多校验后，部分“以前侥幸能跑”的场景会被提前拦截。

兼容策略：

1. 保留现有切换路径不变。
2. 先增加校验、回滚、日志和用户提示，再调整更细的版本策略。
3. 任何与现行切换方式不兼容的重构都不纳入本轮优化。

## 4.7 验收标准

1. 切换 `Qwen ASR`、`Qwen TTS`、`WhisperX`、`Index-TTS` 时，仍使用当前 `site-packages` 切换方案，但失败可被检测、阻断并回滚。
2. `fix-python-env` 可以针对基础缓存、Qwen 缓存或全部缓存执行修复。
3. 预识别字幕流程与后续批量流程在当前切换架构下稳定衔接，不因残缺缓存导致启动失败。
4. 启动日志与 UI 能明确显示当前 action 选择了哪个切换 profile、切换是否成功、当前版本是多少。
5. 文档、代码与实际安装行为不再出现“项目写死 4.57.3，但上游要求 >=4.57.6”这类未说明状态；如果仍保留兼容策略，必须显式标注。

---

## 5. 阶段 B：后端事件协议结构化

## 5.1 目标

替换当前基于 stdout marker 的协议方式，解决：

1. `[PROGRESS]`、`[PARTIAL]`、`[DEPS_INSTALLING]`、`__JSON_START__` 与普通日志混杂。
2. 日志格式稍有变化就会影响 UI 逻辑。
3. Electron 主进程承担了过多字符串解析工作。
4. 当前 `PROGRESS` 只有百分比，没有阶段名、任务名、当前项、总数，用户无法一眼看出“卡在哪一步”。
5. 当前 `stdout/stderr` 没有统一等级、来源和上下文编号，排查问题时很难快速定位是哪个 action、哪个片段、哪个阶段报错。

## 5.2 建议方案

建立统一事件对象协议，并把“用户看得懂的进度”和“开发者能追踪的问题上下文”同时纳入协议。

后端输出统一格式，例如：

```json
{"type":"event","name":"progress","action":"generate_batch_tts","payload":{"value":35}}
{"type":"event","name":"partial_result","action":"generate_batch_tts","payload":{"index":2,"audio_path":"..."}}
{"type":"event","name":"deps_installing","action":"runtime_setup","payload":{"package":"accelerate==1.12.0"}}
{"type":"result","action":"generate_batch_tts","payload":{"success":true,"results":[]}}
```

建议进一步升级为“可读进度 + 结构化日志”双通道。

`progress` 不再只传裸百分比，而是至少包含：

```json
{
  "type": "event",
  "name": "progress",
  "action": "generate_batch_tts",
  "payload": {
    "percent": 42,
    "stage": "tts_generate",
    "stage_label": "正在生成配音",
    "item_index": 21,
    "item_total": 50,
    "message": "第 21/50 条，正在生成第 3 批",
    "detail": "Qwen TTS batch size=8"
  }
}
```

`log` 事件则必须让人一眼看到问题出在哪：

```json
{
  "type": "log",
  "level": "error",
  "action": "generate_batch_tts",
  "payload": {
    "stage": "tts_generate",
    "stage_label": "正在生成配音",
    "code": "QWEN_TTS_BATCH_FAILED",
    "message": "第 21 条生成失败，已切换到兜底参考音频",
    "detail": "CUDA out of memory",
    "item_index": 21,
    "item_total": 50,
    "segment_id": 21,
    "suggestion": "减小批大小或切换到 IndexTTS 重试"
  }
}
```

这样做的目标：

1. 用户界面上能看到“当前步骤 + 当前条目 + 当前动作说明”。
2. 日志里能看到“哪一步、哪条任务、什么错误码、原始原因、建议动作”。
3. 排查时不用翻大量自然语言日志。

## 5.3 具体改动内容

### 5.3.1 新增后端事件发射器

建议新增：

- `backend/event_protocol.py`

提供：

1. `emit_event(name, action, payload)`
2. `emit_result(action, payload)`
3. `emit_log(level, message)`
4. `emit_progress(action, stage, percent, message, extra)`
5. `emit_stage(action, stage, status, message, extra)`

建议统一事件字段：

1. `action`
2. `stage`
3. `stage_label`
4. `item_index`
5. `item_total`
6. `message`
7. `detail`
8. `code`
9. `suggestion`

### 5.3.2 替换 [backend/main.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/main.py) 中散落 marker

涉及文件包括：

- [backend/main.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/main.py)
- [backend/tts.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/tts.py)
- [backend/qwen_tts_service.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/qwen_tts_service.py)
- [backend/tts_action_handlers.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/tts_action_handlers.py)
- [backend/dependency_manager.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/dependency_manager.py)

改法：

1. `[PROGRESS] 50` 改为 `emit_progress(action, stage, percent, message, extra)`
2. `[PARTIAL] {...}` 改为 `emit_event("partial_result", action, payload)`
3. `[DEPS_INSTALLING]` 改为 `emit_event("deps_installing", "runtime_setup", payload)`
4. `__JSON_START__ ... __JSON_END__` 改为单次 `emit_result(...)`

同时把关键流程的阶段名称统一收口，避免每个文件各说各话。

建议统一阶段枚举：

1. `bootstrap`
   - 启动与依赖检查
2. `asr`
   - 识别字幕
3. `translate`
   - 翻译字幕
4. `prepare_reference`
   - 提取参考音频
5. `tts_generate`
   - 生成配音
6. `audio_align`
   - 音频对齐
7. `merge_video`
   - 视频合成
8. `runtime_switch`
   - 版本切换
9. `runtime_repair`
   - 环境修复

建议各类 stdout 输出按下面规则治理：

1. 用户可见进度
   - 只通过 `progress` / `stage` 事件发
2. 用户可见关键提示
   - 通过 `log level=info|warn|error` 发
3. 调试细节
   - 进入 `detail` 字段或仅写入日志文件
4. 最终结果
   - 只通过 `result` 返回

不再允许这些情况继续扩散：

1. 普通 `print()` 同时承担 UI 驱动职责。
2. 一个步骤既发 marker 又发自然语言，再夹一个 stderr。
3. 同类错误没有统一错误码，导致前端无法给出稳定提示。

### 5.3.3 修改 Electron 解析器

文件：

- [ui/electron/main.ts](/C:/Users/MI/Downloads/VideoSyncMaster/ui/electron/main.ts)

改法：

1. 取消 marker 正则解析。
2. 改为逐行尝试解析 JSON event。
3. 仅当无法解析为事件对象时，才作为普通日志输出。

UI 处理规则建议明确成：

1. 收到 `stage` 事件
   - 更新当前步骤标题
2. 收到 `progress` 事件
   - 更新进度条、当前条目、详细说明
3. 收到 `log level=warn|error`
   - 进入“问题列表”面板
4. 收到 `partial_result`
   - 更新当前任务局部结果
5. 收到普通 stdout 文本
   - 仅进入原始日志面板，不参与 UI 状态驱动

这样前端可以同时提供两种视图：

1. 用户视图
   - 只看“正在做什么、做到哪了、哪里出错了”
2. 排障视图
   - 看完整结构化日志和原始 stdout/stderr

### 5.3.4 `PROGRESS` 的直观化要求

这部分建议作为单独验收项，不然很容易只做“换格式”，没有真正变直观。

`PROGRESS` 至少要满足：

1. 一眼看出当前大阶段
   - 例如“正在翻译字幕”“正在生成配音”“正在合成视频”
2. 一眼看出当前子进度
   - 例如“第 21/50 条”“第 3/8 批”
3. 一眼看出是否卡住
   - 长时间停留在同一阶段时，能显示最近动作说明
4. 一眼看出失败位置
   - 例如“第 21 条失败，已自动重试 1/3”
5. 一眼看出下一步动作
   - 例如“正在切换到附近参考音频重试”

建议前端展示文案采用“阶段标题 + 细节副标题”：

1. 标题
   - `正在生成配音`
2. 副标题
   - `第 21/50 条，正在处理第 3 批，已完成 42%`
3. 异常状态
   - `第 21 条失败，正在使用兜底参考音频重试`

### 5.3.5 `stdout/stderr` 的可追踪化要求

原始输出不应再只是堆文本，而应满足“能快速搜问题”的要求。

建议每条结构化日志至少包含：

1. 时间戳
2. `action`
3. `stage`
4. `level`
5. `code`
6. `message`
7. `item_index`
8. `segment_id`

建议错误码按来源分组：

1. `RUNTIME_*`
2. `ASR_*`
3. `TRANSLATE_*`
4. `TTS_*`
5. `MERGE_*`
6. `IO_*`

这样优化后，开发和排障时可以直接按：

1. 看 `error code`
2. 看 `stage`
3. 看 `segment_id`
4. 看 `detail`

而不是先人工从整段日志里猜。

建议拆出：

1. `parseBackendLine(line)`
2. `dispatchBackendEvent(event, sender)`

## 5.4 影响文件

- [ui/electron/main.ts](/C:/Users/MI/Downloads/VideoSyncMaster/ui/electron/main.ts)
- [backend/main.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/main.py)
- [backend/tts.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/tts.py)
- [backend/qwen_tts_service.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/qwen_tts_service.py)
- [backend/tts_action_handlers.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/tts_action_handlers.py)
- [backend/dependency_manager.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/dependency_manager.py)

建议新增文件：

- `backend/event_protocol.py`

## 5.5 兼容策略

建议分两步：

1. 第一阶段支持“新 JSON 事件 + 老 marker”双协议。
2. 第二阶段彻底移除老 marker。
3. 在兼容期内，前端优先消费新事件；老 marker 仅作为兜底，不再继续扩展。

## 5.6 验收标准

1. Electron 不再依赖 `[PROGRESS]` / `[PARTIAL]` 正则解析。
2. 结果返回不再依赖 `__JSON_START__` / `__JSON_END__`。
3. 普通日志文本变化不再影响 UI 的进度和 partial 更新。
4. 进度条不再只显示百分比，而是能显示“当前阶段 + 当前条目 + 当前说明”。
5. 任意失败都能在日志中一眼看到所属阶段、条目编号、错误码和建议动作。

---

## 6. 阶段 C：前端参数构建统一

## 6.1 目标

解决这些问题：

1. 单文件流程、批量流程、单段 TTS、批量 TTS 分别维护多套 CLI 拼参逻辑。
2. `localStorage` 默认值分散。
3. 相同能力在不同流程下拼参并不完全一致。

## 6.2 具体改动内容

### 6.2.1 新增前端 action builders

建议新增：

- `ui/src/services/backendArgs.ts`

提供：

1. `buildAsrArgs(options)`
2. `buildTranslateArgs(options)`
3. `buildSingleTtsArgs(options)`
4. `buildBatchTtsArgs(options)`
5. `buildMergeArgs(options)`
6. `buildPrepareReferenceArgs(options)`

### 6.2.2 统一 Qwen / IndexTTS 参数来源

当前参数分散在：

- [ui/src/hooks/useDubbingWorkflow.ts](/C:/Users/MI/Downloads/VideoSyncMaster/ui/src/hooks/useDubbingWorkflow.ts)
- [ui/src/hooks/useBatchQueue.ts](/C:/Users/MI/Downloads/VideoSyncMaster/ui/src/hooks/useBatchQueue.ts)
- [ui/src/components/QwenTTSConfig.tsx](/C:/Users/MI/Downloads/VideoSyncMaster/ui/src/components/QwenTTSConfig.tsx)
- [ui/src/components/TTSConfig.tsx](/C:/Users/MI/Downloads/VideoSyncMaster/ui/src/components/TTSConfig.tsx)

建议新增：

- `ui/src/services/runtimeSettings.ts`

统一读取：

1. `qwen_mode`
2. `qwen_tts_model`
3. `qwen_ref_audio_path`
4. `qwen_ref_text`
5. `qwen_design_ref_audio`
6. `qwen_voice_instruction`
7. `tts_ref_audio_path`
8. `tts_temperature`
9. `tts_top_p`
10. `tts_repetition_penalty`

### 6.2.3 合并重复冲突规则

当前重复位置：

- [ui/src/hooks/usePersistentSettings.ts](/C:/Users/MI/Downloads/VideoSyncMaster/ui/src/hooks/usePersistentSettings.ts)
- [ui/src/hooks/useVideoProject.ts](/C:/Users/MI/Downloads/VideoSyncMaster/ui/src/hooks/useVideoProject.ts)

建议新增：

- `ui/src/domain/serviceCompatibility.ts`

提供：

1. `validateServiceCombination(asr, tts)`
2. `getServiceConflictMessage(asr, tts, changing)`

## 6.3 影响文件

- [ui/src/hooks/useVideoProject.ts](/C:/Users/MI/Downloads/VideoSyncMaster/ui/src/hooks/useVideoProject.ts)
- [ui/src/hooks/usePersistentSettings.ts](/C:/Users/MI/Downloads/VideoSyncMaster/ui/src/hooks/usePersistentSettings.ts)
- [ui/src/hooks/useDubbingWorkflow.ts](/C:/Users/MI/Downloads/VideoSyncMaster/ui/src/hooks/useDubbingWorkflow.ts)
- [ui/src/hooks/useBatchQueue.ts](/C:/Users/MI/Downloads/VideoSyncMaster/ui/src/hooks/useBatchQueue.ts)

建议新增文件：

- `ui/src/services/backendArgs.ts`
- `ui/src/services/runtimeSettings.ts`
- `ui/src/domain/serviceCompatibility.ts`

## 6.4 验收标准

1. 同一类 action 只有一份拼参逻辑。
2. ASR/TTS 组合冲突规则只有一个来源。
3. 修改 Qwen 配置或 TTS 配置时，单文件与批量流程行为保持一致。

---

## 7. 阶段 D：模型策略层正规化

## 7.1 目标

解决当前“功能已经有了，但策略散落”的问题，重点包括：

1. Qwen TTS 无效 generation flags。
2. WhisperX 语言参数未真正消费。
3. retry / fallback 策略仍是经验散点。

## 7.2 具体改动内容

### 7.2.1 规范 Qwen 生成参数

当前文件：

- [backend/qwen_tts_service.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/qwen_tts_service.py)

建议改法：

1. 建立 Qwen 模型允许的 generation kwargs 白名单。
2. 通过模型能力检测或固定策略决定是否传 `temperature`。
3. 对不接受的参数直接剔除，不再依赖运行时 warning。

建议新增：

- `backend/model_policies/qwen_tts_policy.py`

### 7.2.2 让 WhisperX 真正消费语言参数

当前文件：

- [backend/asr.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/asr.py)

建议改法：

1. 将硬编码语言改为由传入参数或自动判定决定。
2. 若 WhisperX 仅在中文模式稳定，则前后端都应明确说明限制，而不是表面接受参数。

### 7.2.3 正式化 TTS retry 策略

当前文件：

- [backend/tts_action_handlers.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/tts_action_handlers.py)

建议新增：

- `backend/model_policies/tts_retry_policy.py`

抽出这些策略配置：

1. 首次重试参数
2. fallback 参考音频规则
3. IndexTTS 与 Qwen 的差异化重试规则

### 7.2.4 统一音频质量校验输出

当前文件：

- [backend/audio_validation.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/audio_validation.py)

建议：

1. 返回结构化结果对象。
2. 把 `duration`、`peak`、`rms`、`non_silent_ratio` 纳入日志与错误信息。
3. 前端可选择展示“失败原因摘要”。

## 7.3 影响文件

- [backend/asr.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/asr.py)
- [backend/qwen_tts_service.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/qwen_tts_service.py)
- [backend/tts.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/tts.py)
- [backend/tts_action_handlers.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/tts_action_handlers.py)
- [backend/audio_validation.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/audio_validation.py)

建议新增文件：

- `backend/model_policies/qwen_tts_policy.py`
- `backend/model_policies/tts_retry_policy.py`

## 7.4 验收标准

1. Qwen 不再输出无效 generation flag warning。
2. WhisperX 语言参数行为与 UI 显示一致。
3. 单段和批量 TTS 的 retry 策略来源统一。

---

## 8. 阶段 E：主入口拆分与模块边界治理

## 8.1 目标

降低这些单点文件的复杂度：

1. [backend/main.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/main.py)
2. [ui/src/App.tsx](/C:/Users/MI/Downloads/VideoSyncMaster/ui/src/App.tsx)
3. [ui/electron/main.ts](/C:/Users/MI/Downloads/VideoSyncMaster/ui/electron/main.ts)

## 8.2 具体改动内容

### 8.2.1 拆分 `backend/main.py`

建议拆分为：

1. `backend/bootstrap.py`
   - 编码
   - 便携 Python
   - GPU DLL
   - FFmpeg PATH
2. `backend/action_router.py`
   - action 分发
3. `backend/workflows/dub_video_workflow.py`
   - `dub_video()` 全流程编排
4. `backend/result_writer.py`
   - 最终结果输出

### 8.2.2 拆分 Electron 主进程

建议拆分：

1. `ui/electron/backendRunner.ts`
2. `ui/electron/modelDownloads.ts`
3. `ui/electron/pythonEnv.ts`
4. `ui/electron/cacheManager.ts`

### 8.2.3 瘦身 `App.tsx`

建议拆分：

1. 顶部全局状态区
2. 环境修复弹窗管理
3. 批量自动恢复逻辑
4. 工作台布局与播放器控制

## 8.3 验收标准

1. `backend/main.py` 不再同时承担 bootstrap、环境切换、完整编排和结果输出。
2. Electron 主进程不再是所有功能的单文件入口。
3. `App.tsx` 只保留页面装配职责。

---

## 9. 阶段 F：测试、验收与发布治理

## 9.1 测试补齐

优先补这些测试：

1. `backend/asr.py::split_into_subtitles`
2. `backend/qwen_asr_service.py` 的句子对齐 fallback
3. `backend/tts_action_handlers.py::_finalize_batch_tts_results`
4. `ui/src/hooks/useBatchQueue.ts` 的预识别字幕与再次启动队列逻辑
5. `ui/src/hooks/useDubbingWorkflow.ts` 的参数构造

## 9.2 发布治理

当前打包相关文件：

- [package_app.py](/C:/Users/MI/Downloads/VideoSyncMaster/package_app.py)

建议补充：

1. 当前切换缓存打包策略
2. 切换缓存完整性自检
3. 模型完整性自检
4. 首次启动诊断报告

## 9.3 验收用例

审核时建议至少跑以下用例：

1. WhisperX 单文件识别
2. Qwen ASR 单文件识别
3. IndexTTS 单段配音
4. Qwen TTS 单段配音
5. 批量预识别原字幕
6. 停止队列后再次启动
7. 识别后重复再次识别
8. 翻译完成后队列状态刷新
9. 模型下载反馈提示
10. 修复环境后重新切换模型族

---

## 10. 建议审核顺序

建议按这个顺序审核：

1. 先看阶段 A
   - 因为这是在不推翻现有架构前提下，最能直接提升稳定性的部分
2. 再看阶段 B 和 C
   - 这两项决定后续迭代成本
3. 再看阶段 D
   - 这部分解决模型行为稳定性
4. 最后看阶段 E 和 F
   - 这部分属于中长期工程化建设

---

## 11. 最终建议

如果要控制风险，建议分两批推进：

第一批：

1. 阶段 A：切换机制加固与版本契约治理
2. 阶段 B：后端事件协议结构化
3. 阶段 C：前端参数构建统一

第二批：

1. 阶段 D：模型策略层正规化
2. 阶段 E：主入口拆分
3. 阶段 F：测试与发布治理

这样分批的原因：

1. 第一批解决“现有项目能不能在当前切换架构下长期稳定跑”的根问题。
2. 第二批解决“系统能不能优雅扩展和持续维护”的工程问题。
3. 如果第一批不先做，后续任何重构收益都会被环境切换脆弱性和协议脆弱性持续抵消。
