# VideoSyncMaster 商业化工程实施清单

## 当前已落地的工程化收敛

1. 仓库主结构已经切到 `apps/`、`services/`、`resources/`、`runtime/`、`storage/`。
2. 根 `package.json` 已改为面向新目录结构的脚本入口。
3. 后端动作分发补上了统一的未知动作错误返回，不再静默返回 `None`。
4. 新增了可测试的工作流领域对象：
   - `SubtitleSegment`
   - `TranslatedSegment`
   - `DubSegment`
   - `ProcessingSession`
   - `SessionArtifact`
5. 增加了基础单元测试，覆盖：
   - 动作路由
   - Worker 请求 DTO
   - 工作流领域对象

## 推荐作为下一批开发任务的高优先级项

1. 将 `services/media_pipeline/main.py` 继续拆分为：
   - 启动装配层
   - Runtime 注册层
   - 工作流用例入口层
2. 为以下核心流程建立显式应用服务：
   - ASR 工作流
   - 语义分句工作流
   - 片段翻译工作流
   - 批量 TTS 工作流
   - 合成导出工作流
3. 把前端批量任务与单视频任务统一成状态机模型，避免状态散落在多个 Hook。
4. 建立错误码表、事件协议表和日志字段规范文档。
5. 增加回归测试：
   - Session 恢复
   - 批量配音复用
   - 合成失败后的补偿与重试

## 发布前最低门槛

1. `npm run lint`
2. `npm run test:backend`
3. `npm run check:backend`
4. 模型路径与运行时路径检查通过
5. Electron 打包路径验证通过

## 商业化交付还缺的关键能力

1. 安装包升级与版本迁移策略
2. 模型下载失败后的断点续传与校验
3. 统一审计日志与崩溃日志收集
4. 更细粒度的队列恢复与片段级重试策略
5. 更稳定的 TTS Runtime 子进程隔离
