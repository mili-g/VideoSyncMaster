# VideoSyncMaster 具体改进优化方案

## 1. 文档目的

本文档在当前代码基础上，给出一份可执行的项目优化方案。目标不是抽象讨论“应该重构”，而是明确：

- 先做什么
- 为什么做
- 改哪些文件
- 会解决什么问题
- 有哪些风险和回退点

## 2. 当前项目的真实状态

项目当前已经具备以下能力：

- 单文件视频识别、翻译、配音、合成。
- 批处理队列、断点恢复和输出整理。
- 多套 ASR / TTS 路径。
- 本地模型管理、环境检查和修复。

项目当前也存在以下真实瓶颈：

1. 后端统一入口过重，`backend/main.py` 既负责 bootstrap，又负责路由，又负责部分业务编排。
2. 前端多个 Hook 直接构造 CLI 参数，导致协议散落。
3. Electron 通过解析 Python 文本输出同时处理日志和协议，接口脆弱。
4. `backend/dependency_manager.py` 在同一便携 Python 环境中切换依赖版本，导致 Qwen 与 IndexTTS 的组合需要前端互斥规避。
5. 顶层文档与代码状态不同步，历史乱码和旧结论会误导后续维护者。

## 3. 优化目标

本轮优化建议围绕四个目标展开：

### 3.1 稳定性

避免依赖热切换、输出协议漂移、批处理状态不一致等问题继续积累。

### 3.2 可维护性

收敛参数入口、缩小顶层文件职责，让每次改动有明确落点。

### 3.3 可演进性

为未来新增模型、增加批处理策略、改善恢复机制保留空间。

### 3.4 可观测性

让日志、事件、错误输出可以被清楚地区分和追踪。

## 4. 优先级路线图

建议分三阶段推进。

### 阶段一：先治基础契约

目标：

- 解决最容易引发真实故障的底层问题。

内容：

1. 解除模型执行环境互斥。
2. 收敛后端输出协议。
3. 收敛前端参数组装入口。

### 阶段二：拆分大文件与宿主职责

目标：

- 减少改动半径，降低后续功能开发的心智负担。

内容：

1. 拆分 `backend/main.py`
2. 瘦身 `ui/src/App.tsx`
3. 缩小 `ui/electron/main.ts` 的协议职责

### 阶段三：做长期演进整理

目标：

- 建立统一配置、统一状态模型和统一文档基线。

内容：

1. 建立统一配置中心。
2. 规范日志分层与错误模型。
3. 整理文档与实现一致性。

## 5. 阶段一的具体改造建议

### 5.1 用独立 Python 子进程替代依赖热切换

现状：

- IndexTTS 依赖 `transformers 4.52.1`
- Qwen ASR / Qwen TTS 依赖 `transformers 4.57.3`
- 当前通过 `backend/dependency_manager.py` 在同一环境切换 `transformers`、`tokenizers`、`accelerate`

问题：

- 同一进程内模块缓存无法正确刷新。
- Windows 下包文件会被进程占用。
- 前端被迫限制 `Qwen ASR + Index-TTS`。

建议：

1. 保留当前便携 Python 目录结构。
2. 为不同 profile 提供独立启动入口或独立 runner。
3. ASR、翻译、TTS 分阶段各自拉起子进程。
4. 阶段间通过 JSON 文件或标准 JSON 输出交接结果。

最低落地方案：

- 不立即拆成多个完整服务。
- 先让 Electron 根据任务类型启动不同的 Python 命令入口。
- `test_asr`、`generate_batch_tts`、`generate_single_tts` 至少不共享同一长生命周期进程。

建议改动文件：

- `ui/electron/main.ts`
- `backend/main.py`
- `backend/dependency_manager.py`
- 新增后端 runner 文件，例如 `backend/runners/*.py`

收益：

- 可以从根本上解除 Qwen ASR 与 IndexTTS 的互斥。
- 依赖问题从“运行时热切换”降级为“进程级环境选择”。

### 5.2 将 stdout 字符串协议升级为结构化事件

现状：

- Electron 通过 `[PROGRESS]`、`[PARTIAL]`、`[DEPS_INSTALLING]`、`__JSON_START__` 等文本标记解析后端输出。

问题：

- 普通日志和协议消息混在一起。
- 改一条日志可能影响前端解析。
- 不利于以后增加事件类型。

建议：

1. 规定后端事件统一为单行 JSON。
2. 约定事件结构，例如：

```json
{"type":"progress","value":35}
{"type":"deps.installing","package":"transformers==4.57.3"}
{"type":"result","payload":{...}}
{"type":"log","level":"info","message":"..."}
```

3. Electron 只解析 JSON 事件，不再依赖字符串 marker。
4. 普通 debug log 写入日志文件，不参与协议。

建议改动文件：

- `backend/main.py`
- `ui/electron/main.ts`
- `ui/electron/preload.ts`
- `ui/src/hooks/useBackendEvents.ts`

收益：

- 输出契约清晰。
- 更容易增加新事件而不破坏旧逻辑。
- 排障和 UI 解析能够分离。

### 5.3 收敛前端参数组装入口

现状：

- `useVideoProject.ts`
- `useDubbingWorkflow.ts`
- `useBatchQueue.ts`

以上文件都在直接拼接 Python CLI 参数。

问题：

- 参数默认值分散。
- 相同行为在单文件与批处理下可能不一致。
- 前端必须知道太多后端实现细节。

建议：

1. 新建前端参数构建层，例如：
   - `ui/src/services/backendArgs/asr.ts`
   - `ui/src/services/backendArgs/translation.ts`
   - `ui/src/services/backendArgs/tts.ts`
2. UI Hook 只传业务对象，不直接拼 CLI 数组。
3. 所有本地配置读取也通过统一 helper 获取，不在业务 Hook 中散读 `localStorage`。

建议改动文件：

- `ui/src/hooks/useVideoProject.ts`
- `ui/src/hooks/useDubbingWorkflow.ts`
- `ui/src/hooks/useBatchQueue.ts`
- 新增 `ui/src/services/backendArgs/*`

收益：

- 参数逻辑集中。
- 前后端协议变更时影响面更小。
- 更适合补充类型约束和测试。

## 6. 阶段二的具体改造建议

### 6.1 拆分 `backend/main.py`

建议拆成四类模块：

1. `bootstrap`
   - 编码、日志、环境变量、GPU 路径、便携 Python 检查
2. `dispatch`
   - action 路由
3. `protocol`
   - 事件输出、错误输出、结果输出
4. `workflows`
   - 单文件整链路编排，如 `dub_video`

建议目录结构：

```text
backend/
  bootstrap/
  protocol/
  workflows/
  runners/
  main.py
```

收益：

- 降低入口文件复杂度。
- 更方便为不同子进程入口复用 bootstrap。

### 6.2 瘦身 `ui/src/App.tsx`

当前 `App.tsx` 混合了：

- 页面切换
- 版式拖拽
- 环境检查
- 自动恢复
- 播放器控制
- 工作流接线

建议拆分：

1. `useLayoutState`
2. `useEnvironmentGuard`
3. `useMediaPreview`
4. `AppShell` / `HomeView` / `BatchView`

收益：

- 顶层组件更接近装配层。
- 工作流逻辑和布局逻辑解耦。

### 6.3 收缩 Electron 主进程边界

建议把 `ui/electron/main.ts` 拆成：

1. `backendProcess.ts`
   - Python 进程管理
2. `envTools.ts`
   - 环境检查和修复
3. `downloads.ts`
   - 模型与文件下载
4. `ipcHandlers.ts`
   - IPC 注册

收益：

- 主进程改动影响面更小。
- 更容易单独定位进程问题、下载问题、环境问题。

## 7. 阶段三的具体改造建议

### 7.1 建立统一配置中心

建议建立一层前端配置管理：

- 统一 localStorage key
- 统一默认值
- 统一读写接口
- 区分用户配置、运行态缓存、队列持久化状态

建议新增：

- `ui/src/config/settings.ts`
- `ui/src/config/storage.ts`

### 7.2 统一错误模型

建议区分三类错误：

1. 用户输入错误
2. 运行环境错误
3. 后端执行错误

每类错误都返回结构化对象，而不是前端通过字符串猜测。

### 7.3 整理项目文档

建议至少保留三类核心文档：

1. `PROJECT_ANALYSIS_V2.md`
   - 面向架构理解
2. `PROJECT_IMPROVEMENT_PLAN.md`
   - 面向执行优化
3. `README.md`
   - 面向使用说明

历史文档需要标注“已过时”或归档，避免误导。

## 8. 建议的实施顺序

### 第一周

- 完成后端输出协议梳理。
- 明确独立 Python 子进程方案。
- 落一版统一参数构建层。

### 第二周

- 拆 `backend/main.py` 的 bootstrap 和 dispatch。
- 将 `run-backend` 迁移到结构化事件解析。
- 开始解除 Qwen ASR 与 IndexTTS 的互斥。

### 第三周

- 瘦身 `App.tsx`
- 拆 Electron 主进程模块
- 建立统一设置中心

## 9. 不建议优先做的事

以下事项现在不应排在前面：

- 单纯的大规模 UI 美化
- 单纯的 README 润色
- 在未解决环境切换问题前继续新增模型组合
- 在协议未稳定前继续扩展前端事件分支

这些工作价值存在，但都不如基础契约治理重要。

## 10. 成功标准

本轮优化完成后，至少应满足以下结果：

1. `Qwen ASR + Index-TTS` 不再依赖前端互斥规避。
2. Electron 不再依赖字符串 marker 解析核心协议。
3. 前端只有一套参数构建入口。
4. `backend/main.py` 不再承担完整业务与协议混合职责。
5. 新开发者可以通过分析文档快速理解项目结构和优化方向。

## 11. 结论

`VideoSyncMaster` 当前最需要的不是继续堆新功能，而是把影响系统稳定性和可演进性的三条基础线收紧：

- 模型执行环境
- 输出协议
- 参数入口

只要这三条线先收住，项目后续无论继续增强单文件体验、批处理能力，还是引入更多模型服务，都会容易得多。
