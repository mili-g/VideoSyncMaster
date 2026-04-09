# VideoSyncMaster 运行状态与日志追踪优化方案

## 1. 文档目标

本文档只讨论一条线：

1. 运行状态如何更直观。
2. stdout / stderr 如何更清晰。
3. 错误如何更快定位。
4. 如何在不推翻现有可运行架构的前提下完成优化。

本方案默认保留当前项目的核心事实：

1. 继续使用现有 Python 后端执行方式。
2. 继续使用当前环境切换机制。
3. 不把“日志优化”扩展成“大重构”。

## 2. 当前现状

当前项目并不是完全纯文本日志，而是“混合协议”：

1. 普通日志是文本 `print()`
2. 进度通过 `[PROGRESS] 50`
3. partial 结果通过 `[PARTIAL] {...}`
4. 依赖安装提示通过 `[DEPS_INSTALLING] ...`
5. 最终结果通过 `__JSON_START__ / __JSON_END__` 包裹 JSON

这说明当前系统已经部分结构化，但还没有统一。

## 3. 当前问题

## 3.1 用户视角的问题

当前用户很难一眼看清：

1. 现在到底跑到哪一步了。
2. 当前是在识别、翻译、提取参考音频、生成配音，还是合成视频。
3. 批量任务当前在处理第几条。
4. 卡住时卡在哪个阶段。
5. 出错时错在第几条、哪一步、是否正在自动重试。

现在的 `PROGRESS` 只有百分比，不够直观。

## 3.2 开发与排障视角的问题

当前排查问题时不够高效，原因主要有：

1. stdout 里混有普通日志、协议标记、局部 JSON、最终 JSON。
2. Electron 需要靠正则去猜这一行是什么类型。
3. 很多日志没有统一字段。
4. 相同类型错误缺少统一错误码。
5. 很难快速锁定：
   - 哪个 action
   - 哪个 stage
   - 哪个 segment
   - 哪个批次
   - 是否已经重试

## 3.3 资源与性能上的约束

日志设计不能走极端，不能把所有内容都实时结构化并推给前端，否则会带来：

1. IPC 压力上升
2. 渲染层更新变频繁
3. 大批量任务时日志面板噪音过大
4. 原始调试信息过多时影响可读性

所以正确方向不是“所有日志都变成大 JSON”，而是分层。

## 4. 优化目标

本轮优化需要同时满足 4 个目标：

1. 用户一眼看懂当前运行状态。
2. 出错时一眼看到错误发生在哪一步、哪条任务。
3. 保留完整原始日志用于深度排障。
4. 不让高频日志拖慢前端。

## 5. 建议方案总览

建议把当前输出整理成 4 条通道：

1. `progress`
   - 给 UI 展示当前运行状态
2. `issue`
   - 给 UI 展示警告和错误摘要
3. `result`
   - 给 UI 返回最终结果
4. `raw_log`
   - 详细 stdout/stderr 落盘保存，不全量驱动 UI

核心原则：

1. UI 只消费少量关键状态事件。
2. 大量原始日志只写文件。
3. 错误摘要单独提炼，不再让用户自己读整段日志。

## 6. 运行状态设计

## 6.1 `progress` 事件最小字段

建议 `progress` 只保留必要字段：

```json
{
  "type": "progress",
  "action": "generate_batch_tts",
  "stage": "tts_generate",
  "stage_label": "正在生成配音",
  "percent": 42,
  "item_index": 21,
  "item_total": 50,
  "message": "第 21/50 条，正在处理第 3 批"
}
```

说明：

1. `percent`
   - 总体进度百分比
2. `stage`
   - 机器可识别阶段名
3. `stage_label`
   - UI 展示文案
4. `item_index` / `item_total`
   - 当前条目位置
5. `message`
   - 当前动作摘要

不建议在 `progress` 里放太多冗长字段。

## 6.2 建议统一阶段枚举

建议统一为以下阶段：

1. `bootstrap`
2. `runtime_switch`
3. `runtime_repair`
4. `asr`
5. `translate`
6. `prepare_reference`
7. `tts_generate`
8. `audio_align`
9. `merge_video`
10. `finalize`

这样前后端对同一个阶段有统一口径。

## 6.3 UI 展示建议

前端建议只展示三行核心信息：

1. 主状态
   - `正在生成配音`
2. 次状态
   - `第 21/50 条，已完成 42%`
3. 动作说明
   - `当前使用 Qwen TTS，正在处理第 3 批`

如果进入重试或异常恢复，则直接替换成可读文案：

1. `第 21 条失败，正在自动重试 1/3`
2. `切换到附近参考音频重试`
3. `正在验证 Qwen 依赖切换结果`

## 7. 问题捕捉设计

## 7.1 `issue` 事件

建议为警告和错误单独建立 `issue` 事件：

```json
{
  "type": "issue",
  "level": "error",
  "action": "generate_batch_tts",
  "stage": "tts_generate",
  "code": "TTS_SEGMENT_RETRY",
  "message": "第 21 条生成失败，已进入自动重试",
  "item_index": 21,
  "item_total": 50,
  "detail": "CUDA out of memory",
  "suggestion": "减小批大小或切换到 IndexTTS"
}
```

这样前端不用自己从自然语言日志里提取问题。

## 7.2 错误码建议

建议统一错误码前缀：

1. `RUNTIME_*`
2. `ASR_*`
3. `TRANSLATE_*`
4. `TTS_*`
5. `MERGE_*`
6. `IO_*`
7. `QUEUE_*`

示例：

1. `RUNTIME_SWITCH_VERIFY_FAILED`
2. `RUNTIME_CACHE_MISSING`
3. `ASR_SUBTITLE_PARSE_FAILED`
4. `TTS_SEGMENT_RETRY`
5. `TTS_BATCH_FAILED`
6. `MERGE_OUTPUT_FAILED`
7. `QUEUE_RESUME_FAILED`

## 7.3 问题聚合

同类问题不应连续刷屏。

例如：

1. 不要把 20 条片段失败都逐条弹给用户。
2. 前端面板可以聚合成：
   - `12 个片段首次生成失败，系统已自动重试`
3. 点击后再展开最近 3 条详细问题。

这样既直观，也不会让日志面板爆炸。

## 8. 原始日志设计

## 8.1 原始 stdout / stderr 的定位

原始日志仍然非常重要，但不应该继续承担 UI 协议职责。

它们的职责应改为：

1. 保留详细调试信息
2. 保留 traceback
3. 保留模型原始 warning
4. 保留依赖切换细节
5. 作为深度排障依据

## 8.2 建议做法

1. 实时状态只发 `progress`
2. 异常摘要只发 `issue`
3. 最终结果只发 `result`
4. 完整 stdout/stderr 写入日志文件

前端只需要：

1. 显示最近几条摘要
2. 提供“查看完整日志”
3. 出错时关联日志文件位置

## 8.3 原始日志建议格式

即使写入文件，也建议统一前缀，方便搜索：

```text
[2026-04-09 15:20:10] [INFO] [generate_batch_tts] [tts_generate] Segment 21 started
[2026-04-09 15:20:12] [WARN] [generate_batch_tts] [tts_generate] [TTS_SEGMENT_RETRY] Segment 21 failed first attempt
[2026-04-09 15:20:13] [ERROR] [generate_batch_tts] [tts_generate] [TTS_BATCH_FAILED] CUDA out of memory
```

建议至少统一这些维度：

1. 时间
2. 级别
3. action
4. stage
5. code
6. message

## 9. 与当前项目的最小兼容改法

为了不推翻当前项目，可以采用最小变更方案：

1. 保留现有结果 JSON 返回方式
2. 保留原始 stdout/stderr
3. 先新增轻量 `progress` / `issue` 事件
4. 现有 `[PROGRESS]` / `[PARTIAL]` / `__JSON_START__` 在过渡期兼容
5. 前端优先消费新事件，老 marker 只做兜底

这意味着第一阶段不必一次性删光老协议。

## 10. 与当前代码的对应改动点

重点影响文件：

1. [ui/electron/main.ts](/C:/Users/MI/Downloads/VideoSyncMaster/ui/electron/main.ts)
2. [backend/main.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/main.py)
3. [backend/tts.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/tts.py)
4. [backend/qwen_tts_service.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/qwen_tts_service.py)
5. [backend/tts_action_handlers.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/tts_action_handlers.py)
6. [backend/dependency_manager.py](/C:/Users/MI/Downloads/VideoSyncMaster/backend/dependency_manager.py)

建议新增：

1. `backend/event_protocol.py`
2. `backend/error_codes.py`

## 11. 实施顺序建议

建议按 4 步做：

1. 第一步：补轻量状态事件
   - 先统一 `progress`
   - 让 UI 直接显示阶段和当前条目
2. 第二步：补 `issue` 事件
   - 提炼错误摘要和建议动作
3. 第三步：原始日志落盘统一前缀
   - 提升排障效率
4. 第四步：收口老 marker
   - 前端不再依赖正则猜协议

## 12. 验收标准

完成后，至少应满足：

1. 用户一眼能看出当前运行阶段。
2. 用户一眼能看出当前处理到第几条。
3. 卡住时能看出最后一个动作。
4. 出错时能看出错误发生在哪个阶段、哪条任务。
5. 前端不需要继续从海量普通文本里猜进度。
6. 完整日志仍然可追溯、可检索、可定位。

## 13. 最终建议

这条优化线最适合采用“轻事件 + 重日志文件”的方式：

1. 轻事件负责状态可视化。
2. issue 负责问题捕捉。
3. result 负责最终返回。
4. raw_log 负责深度排障。

这样既能让运行状态更直观，也能让错误定位更快，同时不会因为日志量过大把前端和 IPC 拖慢。
