# VideoSyncMaster 项目分析 V2

## 1. 文档目标与分析方法

本文档基于当前仓库真实代码实现重写，不沿用旧版抽象描述，重点回答以下问题：

1. 当前项目到底是怎样运作的，主链路如何穿透 UI、Electron、Python 后端与本地环境。
2. Qwen ASR、Qwen TTS、WhisperX、Index-TTS 之间的依赖版本冲突在代码里是如何被“规避”的，这套方式为什么脆弱。
3. 单文件流程、批量流程、预识别字幕流程分别由哪些函数真正驱动，哪里是关键耦合点。
4. 当前架构是否具备商业级稳定性，距离稳定商用工程还缺哪些基础契约。
5. 后续优化应该先做什么，为什么这样排序。

本次分析不是只看组件名和目录名，而是顺着实际执行路径做代码级梳理，重点检查了这些文件：

- `ui/src/App.tsx`
- `ui/src/hooks/useVideoProject.ts`
- `ui/src/hooks/useTranslationWorkflow.ts`
- `ui/src/hooks/useDubbingWorkflow.ts`
- `ui/src/hooks/useBatchQueue.ts`
- `ui/src/hooks/useBackendEvents.ts`
- `ui/electron/main.ts`
- `backend/main.py`
- `backend/action_handlers.py`
- `backend/cli_options.py`
- `backend/dependency_manager.py`
- `backend/asr.py`
- `backend/qwen_asr_service.py`
- `backend/tts.py`
- `backend/qwen_tts_service.py`
- `backend/tts_action_handlers.py`
- `backend/llm.py`
- `requirements.txt`
- `Qwen3-ASR/pyproject.toml`
- `backend/Qwen3-TTS/pyproject.toml`

## 2. 项目真实定位

`VideoSyncMaster` 已经不是简单的“AI 视频翻译 demo”，它实际上是一个本地桌面端多引擎媒体处理编排器，具备如下真实能力：

1. 单文件视频字幕识别、翻译、配音、合成。
2. 批量导入视频和字幕，并按文件名自动归并工件。
3. 批量预识别原字幕，再切换配置跑后续批处理。
4. 同时支持 WhisperX、Qwen3-ASR、剪映、Bcut 多种 ASR 路径。
5. 同时支持 Index-TTS、Qwen3-TTS 两条 TTS 路径。
6. 支持外部翻译 API 与本地 Qwen 翻译模型。
7. 支持失败片段重试、近邻参考音频回退、全局兜底参考音频。
8. 支持环境检测、依赖修复、模型下载、日志查看、缓存清理。

从工程本质上看，这个项目的核心难度已经从“模型调用”转向了“异构模型族、异构依赖、异构工作流在同一桌面壳中如何稳定编排”。

## 3. 系统分层与职责

### 3.1 渲染层：React 工作流编排

主要入口：

- `ui/src/App.tsx`
- `ui/src/hooks/useVideoProject.ts`
- `ui/src/hooks/useTranslationWorkflow.ts`
- `ui/src/hooks/useDubbingWorkflow.ts`
- `ui/src/hooks/useBatchQueue.ts`

这一层不只是“页面展示”，而是实际承担了大量业务编排职责：

1. 决定当前使用哪个 ASR/TTS。
2. 从 `localStorage` 聚合参数。
3. 构造后端 CLI 参数数组。
4. 决定是走单文件、批量还是预识别字幕。
5. 在收到后端 partial/progress 事件后，把结果回填到 UI 状态树。

结论：

- 当前前端已经不是薄 UI，而是“半编排器”。
- 优点是功能推进快。
- 缺点是前端过度理解后端协议和环境规则，导致跨层耦合严重。

### 3.2 宿主层：Electron 进程和 IPC 桥接

核心文件：

- `ui/electron/main.ts`
- `ui/electron/preload.ts`

真实职责：

1. 启动窗口与处理桌面壳交互。
2. 管理 Python 进程生命周期。
3. 从 stdout 中解析 `[PROGRESS]`、`[PARTIAL]`、`[DEPS_INSTALLING]`、`[DEPS_DONE]` 以及 `__JSON_START__` 包裹的结果。
4. 提供文件保存、目录创建、日志打开、模型下载、环境修复、文件缓存、文件外部打开等宿主能力。

结论：

- Electron 主进程已经成为“协议路由器 + 下载器 + 环境运维器 + 进程管理器”的复合角色。
- 这不是不能做，但随着功能增长，主进程会越来越像一个没有正式边界的服务总线。

### 3.3 执行层：Python 动作路由与模型调度

核心文件：

- `backend/main.py`
- `backend/action_handlers.py`
- `backend/tts_action_handlers.py`
- `backend/cli_options.py`

真实职责：

1. 解析 CLI 参数。
2. 根据 `--action` 路由到 ASR、翻译、单段 TTS、批量 TTS、参考音频准备、视频合成等动作。
3. 根据 TTS/ASR 类型切换依赖版本。
4. 在 stdout 上同时输出日志、进度和结构化事件。

结论：

- 这层已经是实际业务中枢。
- 问题不是“没有拆模块”，而是“入口文件、协议、环境切换都在运行时交织”。

### 3.4 环境层：便携 Python 与模型资源

主要目录：

- `python/`
- `models/`
- `.env_cache/`
- `.cache/`
- `Qwen3-ASR/`
- `backend/Qwen3-TTS/`

这一层决定了项目稳定性的上限。

因为当前系统不是在不同虚拟环境中隔离模型族，而是在同一个便携 Python 环境里动态切换关键包版本，环境层本身已经成为业务约束的一部分。

## 4. 真实运行链路梳理

## 4.1 单文件识别链路

入口在 `useVideoProject.handleASR()`。

真实执行过程：

1. 读取 `asrService`、`asrOriLang`、WhisperX 的 `vad_onset/vad_offset`。
2. 构造 `runBackend([ '--action', 'test_asr', ... ])`。
3. Electron `run-backend` 调用 `backend/main.py --json --model_dir ... --action test_asr ...`。
4. `backend/action_handlers.py::dispatch_basic_action()` 命中 `test_asr`。
5. `backend/asr.py::run_asr()` 再根据 service 分流到：
   - `jianying`
   - `bcut`
   - `qwen`
   - 默认 `whisperx`

这里有两个非常关键的实现事实：

1. `run_asr()` 在处理视频输入时先用 `pydub` 提取缓存音频，并按绝对路径做 hash 缓存。
2. WhisperX 路径虽然接收 `language` 参数，但在 `model.transcribe(...)` 里实际写死了 `language="zh"`。

第二点意味着：

- UI 提供了 `asrOriLang`。
- CLI 也传入了 `--ori_lang`。
- 但 WhisperX 真正转写时并没有忠实消费这个参数。
- 这会让“用户以为切了语言，实际 WhisperX 仍按中文走”的风险长期存在。

## 4.2 Qwen ASR 识别链路

`backend/asr.py::run_asr()` 在 `service == "qwen"` 时，调用 `backend/qwen_asr_service.py::run_qwen_asr_inference()`。

这条链路的关键步骤如下：

1. 模块导入时先调用 `ensure_transformers_version("4.57.3")`。
2. 将本地 `Qwen3-ASR` 仓库目录插入 `sys.path`。
3. 本地解析模型路径 `models/Qwen3-ASR-*` 和 forced aligner `models/Qwen3-ForcedAligner-0.6B`。
4. 调用 `Qwen3ASRModel.from_pretrained(...)`。
5. 用 `return_time_stamps=True` 取回 token 级时间戳。
6. 通过 `_split_text_into_sentences()`、`_consume_sentence_tokens()`、`_fallback_segment_tokens()` 二次重组字幕段。

这条路径的优点：

1. 不是直接把模型返回结果原样塞给 UI，而是做了句子对齐和 oversized segment 拆分。
2. 通过 forced aligner 获得相对高质量时间戳。

风险点：

1. 该模块在 import 时就切环境，副作用很重。
2. 它要求 aligner 必须存在，否则直接失败。
3. `Qwen3-ASR/pyproject.toml` 要求 `transformers>=4.57.6`，而项目自己的 `dependency_manager.py` 固定切到 `4.57.3`。

这不是抽象风险，而是实打实的版本契约冲突。

## 4.3 翻译链路

翻译逻辑分成 UI 编排与 Python 模型执行两段：

- UI：`useTranslationWorkflow.ts`
- Python：`backend/main.py::translate_text()` + `backend/llm.py::LLMTranslator`

真实行为：

1. 如果前端配置了 `trans_api_key`，走外部 chat completions。
2. 否则走本地 `Qwen2.5-7B-Instruct`。
3. 外部 API 批量翻译是一次性构造 JSON list prompt，再尝试从模型返回中解析 JSON。
4. 本地翻译则是逐段循环调用 `translate()`。

优点：

1. 外部 API 路径做了批量化，减少网络往返。
2. 对返回结果做了 `_clean_response()`，尽量剥离思维链、引用和解释。

风险：

1. 翻译配置完全散落在 `localStorage` 与调用点，没有统一 schema。
2. 本地翻译模型与 Qwen ASR/Qwen TTS 同属 transformers 系生态，但没有被纳入统一环境画像。
3. 外部 API 解析策略仍然依赖 prompt 和宽松 JSON 抽取，稳定性不等于协议。

## 4.4 单段与批量 TTS 链路

单文件配音由 `useDubbingWorkflow.ts` 驱动，最终落到：

- `backend/tts_action_handlers.py::handle_generate_single_tts`
- `backend/tts_action_handlers.py::handle_generate_batch_tts`
- `backend/tts_action_handlers.py::generate_batch_tts_results`

这部分是当前项目复杂度最高、也最接近产品价值核心的区域。

真实机制包括：

1. 为每个片段抽取局部参考音频。
2. 对过短参考音频跳过直接 segment retry。
3. 优先使用当前片段参考音频。
4. 失败后尝试近邻成功音频。
5. 再失败后尝试全局 fallback 参考音频。
6. 最终把 partial 成功结果持续通过 `[PARTIAL]` 推回前端。

这说明项目已经不是“调用一次 TTS 就结束”，而是显式实现了一个多层降级重试系统。

这部分优点很明显：

1. 重试链路设计成熟。
2. 参考音频策略有明显的经验积累。
3. 单段与批量共享了大部分 TTS 失败恢复逻辑。

但问题也同样明显：

1. 这套逻辑高度依赖 stdout 协议和运行时 side effects。
2. retry 参数调整只对 `IndexTTS` 生效，Qwen 的退化策略并不等价。
3. 过多策略通过 kwargs 散射传递，缺少正式的任务 schema。

## 4.5 批量处理链路

核心在 `ui/src/hooks/useBatchQueue.ts`。

当前批量链路实际上有两条：

1. 标准批处理链路：原字幕/翻译字幕足够时，跳过前置步骤，直接翻译、TTS、合成。
2. 预识别原字幕链路：先批量跑 `test_asr`，把 `originalSubtitlePath` / `originalSubtitleContent` 固化到任务中，再切回别的引擎继续跑。

这条设计有一个非常现实且正确的工程判断：

- 没有试图在一次后端运行里同时混用 Qwen ASR 与 Index-TTS。
- 而是通过“阶段落盘、后续复用工件”的方式跨环境协作。

这恰好说明当前架构的真实瓶颈不是流程编排，而是运行环境不能稳定共存。

## 5. 依赖版本与环境切换：当前最大的真实风险

## 5.1 当前版本契约并不一致

项目当前至少存在四套互相不完全一致的版本来源：

### A. `requirements.txt`

固定为：

- `transformers==4.52.1`
- `accelerate==1.8.1`
- `tokenizers==0.21.0`

这套更像是 IndexTTS / WhisperX 的基础环境。

### B. `backend/dependency_manager.py`

定义：

- `PROFILE_INDEX_TTS = "4.52.1"`
- `PROFILE_QWEN3 = "4.57.3"`
- 当切到 Qwen3 时，如果 `accelerate != 1.12.0`，会额外安装 `accelerate==1.12.0`

### C. `backend/Qwen3-TTS/pyproject.toml`

要求：

- `transformers==4.57.3`
- `accelerate==1.12.0`

### D. `Qwen3-ASR/pyproject.toml`

要求：

- `transformers>=4.57.6`
- `accelerate==1.12.0`

这里最重要的结论是：

1. Qwen3-TTS 与项目内置 Qwen profile 对齐。
2. Qwen3-ASR 的 upstream 需求比项目定义的 `4.57.3` 更高。
3. `fix-python-env` 仍会按 `requirements.txt` 把环境修回 `transformers==4.52.1 + accelerate==1.8.1`。

这意味着“环境修复成功”并不等于“Qwen ASR/TTS 环境处于正确状态”。

## 5.2 当前的环境切换方式是什么

`backend/dependency_manager.py::swap_environment()` 的做法不是虚拟环境隔离，而是：

1. 在当前 Python 的 `site-packages` 下查找 `transformers/tokenizers/accelerate`。
2. 把当前版本整体搬去 `.env_cache/v_xxx/`。
3. 再把目标版本从 `.env_cache/v_target/` 搬回来。
4. 缓存没有时再执行 `pip install`。

这是一种“目录级热切换”。

它能跑，但它天然有这些问题：

1. 切换不是原子事务，中途失败会导致环境半残。
2. 只有三个包被显式搬运，其它被这些包间接影响的依赖并没有统一画像。
3. 版本恢复依赖 `.env_cache` 完整性，而不是正式 lockfile。
4. 同一进程生命周期内 import 缓存、模块状态、CUDA 资源不一定和目录切换同步。

## 5.3 代码里哪些地方会触发环境切换

目前至少有这些入口会触发：

1. `backend/main.py::get_tts_runner()`：
   - `qwen` 时切 `4.57.3`
   - `indextts` 时切 `4.52.1`
2. `backend/qwen_asr_service.py` 在模块导入时切 `4.57.3`
3. `backend/qwen_tts_service.py` 在模块导入时切 `4.57.3`
4. `backend/tts.py` 在模块导入时切 `4.52.1`

这说明环境切换不是集中发生的，而是散落在 import 时和运行时两种阶段。

这是非常危险的设计信号：

- import 本应是“拿定义”，现在却同时在“修改运行环境”。
- 难以推断某次任务究竟是谁触发了版本切换。

## 5.4 前端为什么要禁止 Qwen ASR + Index-TTS

UI 的冲突规则在两处重复定义：

- `ui/src/hooks/usePersistentSettings.ts`
- `ui/src/hooks/useVideoProject.ts`

规则内容都是：

- 如果 `asr === 'qwen' && tts === 'indextts'`，则拒绝切换并弹提示。

这说明产品层已经显式承认当前环境不支持该组合。

但这里有两个更深层的问题：

1. 冲突规则在两处重复维护，后续容易漂移。
2. 规则只覆盖了 UI 可见的组合，没有覆盖“依赖修复后版本漂移”“翻译模型与 Qwen 生态耦合”“批量任务中跨阶段切换”等更深层环境状态。

## 6. 函数级审计结论

## 6.1 `backend/main.py`

这是当前项目后端最重的单点文件，真实承担了太多职责：

1. UTF-8/子进程编码修复。
2. 便携 Python bootstrap。
3. 日志写入。
4. 模型目录定位。
5. FFmpeg 路径注入。
6. GPU DLL 路径修复。
7. TTS runner 选择与依赖切换。
8. 翻译动作包装。
9. `dub_video` 端到端编排。
10. 动作路由入口。

尤其值得指出的代码事实：

1. `main()` 在完成 `dispatch_basic_action()` 和 JSON 输出后，后面还残留一段旧式 `if args.action == 'asr'` 逻辑，基本属于死代码或历史遗留逻辑。
2. `dub_video()` 内部直接串起 ASR、翻译、批量 TTS、自动对齐、视频合成，是一个超长 orchestration function。

判断：

- 当前后端不是没有模块，而是“已经拆了模块，但主入口仍然吞掉了太多编排逻辑”。

## 6.2 `backend/asr.py`

优点：

1. 视频输入会先提音频并做缓存。
2. WhisperX 路径做了较细的字幕切分。
3. 对本地对齐模型缺失做了显式提示。

问题：

1. WhisperX 转写时语言写死成 `zh`。
2. `torch.load` 被全局 monkey patch 成 `weights_only=False`，这是带全局副作用的安全关闭方式。
3. `split_into_subtitles()` 过长，包含太多修正逻辑、经验参数和时间戳补丁，难以测试。

## 6.3 `backend/qwen_asr_service.py`

优点：

1. 对 token 时间戳做了句级重构，不是简单粗暴切片。
2. 具备 oversized segment fallback。

问题：

1. 模块 import 阶段就切依赖。
2. 版本要求与 upstream `pyproject` 不一致。
3. 句子对齐算法和 token fallback 是高价值逻辑，但没有单元测试保护。

## 6.4 `backend/qwen_tts_service.py`

优点：

1. 统一封装了 clone/design/preset 三种模式。
2. 有模型缓存 `_loaded_models`。
3. 有自适应 `max_new_tokens` 与生成音频校验。

问题：

1. `_build_qwen_generation_kwargs()` 仍然默认注入 `temperature/top_p/repetition_penalty`。
2. 用户此前遇到的 `The following generation flags are not valid and may be ignored: ['temperature']`，根源就在这一层：项目仍在向某些 Qwen 生成路径传入上游模型并不严格接受的 generation flag。
3. 这说明“UI 已隐藏高级参数”并不等于“后端不再传这些参数”。

换句话说，界面层已经想托管参数，但执行层还保留着旧行为。

## 6.5 `backend/tts.py`

优点：

1. 对 IndexTTS 的生成参数做了文本长度约束。
2. 做了时长异常和静音音频校验。

问题：

1. 模块 import 时切 `4.52.1`。
2. 单段和批量都在每次调用时初始化 `IndexTTS2`，虽然后者是一轮 batch 内复用，但跨任务没有复用。
3. 逻辑层已经实现了防 hallucination，但与 UI 没有形成正式质量指标契约。

## 6.6 `backend/tts_action_handlers.py`

这是当前最值得保留和继续沉淀的业务逻辑模块之一。

它的价值在于：

1. 参考音频提取逻辑集中。
2. 近邻成功引用和共享 fallback 引用设计成熟。
3. 批处理重试逻辑比很多同类项目完整。

但同样需要指出：

1. retry 策略是经验型参数，没有配置模型。
2. 这套逻辑依赖大量动态 kwargs。
3. `generate_batch_tts_results()` 和 `_finalize_batch_tts_results()` 已经接近一个“子状态机”，却没有正式状态模型。

## 6.7 `ui/src/hooks/useVideoProject.ts`

优点：

1. 单文件工作流入口清晰。
2. 已把翻译、配音、字幕导入拆进独立 hook。

问题：

1. 与 `usePersistentSettings.ts` 重复定义了 ASR/TTS 冲突规则。
2. `handleASR()`、`handleOneClickRun()`、`handleTranslateAndDub()` 仍然直接理解后端参数细节。
3. 这层既做总协调，又做部分业务校验，边界还不稳。

## 6.8 `ui/src/hooks/useBatchQueue.ts`

当前这份代码比旧版本成熟很多，尤其是：

1. 批量队列可持久化和恢复。
2. 已支持“仅识别缺失原字幕项”。
3. 已加入阶段键 `stageKey`，把显示文案和状态识别解耦。

但从工程角度看，仍存在三个问题：

1. 这里依然直接构造 CLI 参数。
2. 单文件和批量流程分别维护了一套拼参逻辑，存在漂移风险。
3. 队列项数据结构已经接近任务工件数据库，但目前只存在浏览器 `localStorage` 中。

## 6.9 `ui/electron/main.ts`

问题非常集中：

1. `run-backend` 同时承担进程启动、编码解码、stdout 协议解析、JSON 提取。
2. JSON 是靠 `__JSON_START__` / `__JSON_END__` 再做二次截取。
3. 普通日志、结构化事件、依赖安装事件全部混在一个 stdout 通道。

这套方式在项目早期很实用，但现在已经成为扩展瓶颈。

## 7. 日志、反馈与协议审计

当前项目有四种反馈通道同时存在：

1. 顶部 `status` 文本。
2. `feedback` 弹窗。
3. Electron 主进程控制台日志。
4. Python stdout/stderr 协议输出。

再叠加：

5. `[PROGRESS]`
6. `[PARTIAL]`
7. `[DEPS_INSTALLING]`
8. `[DEPS_DONE]`
9. `__JSON_START__`

当前状态下的问题不是“有没有提示”，而是“协议与日志共道”：

1. 一旦日志格式变化，UI 解析就可能受影响。
2. stdout 既承载人类可读信息，也承载机器事件。
3. 某些问题看上去像日志异常，实际上会变成功能异常。

这已经不适合再继续叠加新 marker 了。

## 8. 文本编码与乱码结论

当前核心业务源码没有发现系统性的真实文本损坏问题。

更准确的结论是：

1. 项目做了大量 UTF-8 兜底和 Windows 编码兼容。
2. Electron 主进程有 `decodeProcessChunk()`，会在 UTF-8 与 GBK 之间择优。
3. Python 入口也强制了 `PYTHONUTF8` 和 `PYTHONIOENCODING=utf-8`。

所以大部分“乱码观感”来自控制台或子进程输出，而不是仓库源码本身坏掉。

但这不代表编码问题已经彻底解决，因为：

1. 编码修复逻辑散落在多层。
2. 仍然是经验型解码，而不是统一的结构化通道。

## 9. 架构健壮性与可扩展性评估

## 9.1 是否健壮

结论：

- 功能层面已可用。
- 工程层面仍未达到商业级稳定。

最根本的原因不是单个 bug，而是三类基础契约尚未建立：

1. 依赖版本契约。
2. 动作参数契约。
3. 事件输出契约。

## 9.2 是否可扩展

结论：

- 业务能力可扩展。
- 运行环境不可持续扩展。

也就是说：

- 再加一个模型，从 UI 到后端是能接的。
- 但每加一个模型，环境冲突、参数分散和协议脆弱性都会继续累积。

## 10. 当前最重要的真实问题清单

### P0：依赖版本契约断裂

具体表现：

1. `requirements.txt`、`dependency_manager.py`、`Qwen3-ASR/pyproject.toml`、`backend/Qwen3-TTS/pyproject.toml` 不一致。
2. `fix-python-env` 修好的是基础环境，不是 Qwen 可运行环境。
3. `Qwen3-ASR` 上游要求 `transformers>=4.57.6`，项目内部只切到 `4.57.3`。

这会直接影响：

1. ASR/TTS 切换稳定性。
2. 批量预识别字幕后的后续流程稳定性。
3. 新机器首次安装后的可复现性。

### P0：运行期热切 `site-packages`

这是当前最重的工程风险。

一旦切换过程中中断、缓存损坏、模块残留或 pip 安装异常，就可能进入不可预测状态。

### P1：协议和日志混流

当前 UI 行为强依赖 stdout marker，这在复杂工程中不可持续。

### P1：前端拼参分散

当前单文件、批量、单段重试、批量预识别字幕分别维护多套参数构造方式，后续很容易漂移。

### P1：冲突规则重复维护

`validateServiceIncompatibility` 在两处重复实现，后续必然有维护漂移风险。

### P2：高价值算法逻辑缺少测试护栏

尤其是：

1. `split_into_subtitles()`
2. Qwen ASR 句子-token 对齐逻辑
3. 批量 TTS fallback/retry 状态机

## 11. 商业级优化方案与选型理由

## 11.1 第一优先级：停止同环境热切，改为环境分区或任务级解释器隔离

推荐方案：

1. 为 `IndexTTS/WhisperX` 准备一个独立运行环境。
2. 为 `Qwen3-ASR/Qwen3-TTS` 准备另一个独立运行环境。
3. Electron 根据 action 选择不同 python 可执行文件或 launcher。

为什么优先做这个：

1. 它是当前所有“不能同时启用”“切回来才能跑”“修复环境后又不对”的根因。
2. 一旦隔离环境，UI 冲突规则可以从“硬禁止”升级为“可并存但任务分阶段运行”。

## 11.2 第二优先级：建立正式的环境画像文件

建议新增类似：

- `env_profiles/index_tts.lock`
- `env_profiles/qwen.lock`

至少把这些信息固定下来：

1. Python 版本
2. transformers/tokenizers/accelerate 版本
3. torch / torchaudio / torchvision 版本
4. Qwen3-ASR/Qwen3-TTS 对应上游 commit 或版本

这样可以终止“代码里说一种版本，requirements 里写另一种，上游 pyproject 又是第三种”的状态。

## 11.3 第三优先级：把后端 stdout marker 改成结构化事件

建议：

1. 让 Python 只输出 JSON event。
2. Electron 主进程只按 event schema 转发。
3. 普通日志写文件，不再和 UI 通道混用。

最低可行 event schema：

```json
{
  "type": "progress|partial|deps|result|log|error",
  "action": "test_asr|generate_batch_tts|merge_video",
  "payload": {},
  "timestamp": "2026-04-09T13:00:00Z"
}
```

## 11.4 第四优先级：统一前端动作参数构建

建议建立前端 action builder：

1. `buildAsrArgs()`
2. `buildTranslateArgs()`
3. `buildSingleTtsArgs()`
4. `buildBatchTtsArgs()`
5. `buildMergeArgs()`

并让单文件和批量共享同一套参数拼装逻辑。

这样能立刻降低：

1. 参数漂移
2. 默认值分散
3. 本地存储 key 到 CLI 形态的耦合

## 11.5 第五优先级：把 Qwen 与 IndexTTS 的生成参数策略正式化

当前项目处于一种尴尬状态：

1. UI 想“托管高级参数”。
2. 后端仍在向模型传 `temperature/top_p/...`。
3. 不同模型路径对这些参数的接受程度不一致。

建议：

1. 为每个模型族定义正式的可接受参数白名单。
2. 对不支持的参数直接在后端剔除。
3. 将“高级参数托管策略”写成策略对象，而不是散落在多个函数里。

这能直接解决此前出现的 generation flags warning。

## 11.6 第六优先级：拆分 `backend/main.py`

建议最少拆成：

1. `bootstrap.py`
2. `env_runtime.py`
3. `event_protocol.py`
4. `workflow_dub_video.py`
5. `action_router.py`

原因：

- 当前主入口已经承担了太多跨域逻辑，不利于测试与演进。

## 11.7 第七优先级：建立关键函数测试

优先级最高的测试对象：

1. `split_into_subtitles()`
2. `run_qwen_asr_inference()` 里的句子对齐与 fallback 分段
3. `_finalize_batch_tts_results()` 的重试和回退路径
4. 前端 `buildTtsExtraArgs()` / 批量预识别字幕流程

## 12. 结论

当前 `VideoSyncMaster` 的产品能力已经很强，真正的问题不是“功能太少”，而是“工程契约没有收口”。

本次深入代码审查后的核心判断如下：

1. 项目的主要架构风险不在 UI 视觉层，而在运行环境层。
2. Qwen ASR / Qwen TTS / WhisperX / Index-TTS 不是单纯“不能共存”，而是当前通过热切 `site-packages` 在同一便携 Python 中勉强共存。
3. 这套方案已经支撑了当前功能，但它不具备长期稳定放大能力。
4. `requirements.txt`、环境切换器、Qwen 上游 pyproject 的版本要求目前并不完全一致，这是当前最需要正视的问题。
5. 项目里已经有一些非常有价值的工程积累，尤其是批量 TTS 回退体系、批量预识别字幕、Qwen ASR 句级对齐后处理，这些不应该推倒重来，而应该被更正式的架构托住。

因此，最合理的后续路线不是大范围重写，而是按以下顺序收口：

1. 先做环境隔离和版本契约统一。
2. 再做 stdout 协议结构化。
3. 然后统一前端参数构建与冲突规则。
4. 最后继续拆分后端入口并补测试。

只要按这个顺序推进，这个项目完全有机会从“强功能、强经验驱动”的本地工具，升级为“稳定、可复现、可持续扩展”的商业级桌面工程。
