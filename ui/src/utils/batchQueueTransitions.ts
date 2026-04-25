import { BATCH_QUEUE_STAGE, createStage, type BatchQueueItem, type BatchQueueStageKey } from './batchQueueTypes';
import type { StructuredErrorInfo } from '../types/workflow';

function withElapsed(current: BatchQueueItem, finishedAt: number) {
    return {
        finishedAt,
        elapsedMs: current.startedAt ? Math.max(0, finishedAt - current.startedAt) : current.elapsedMs
    };
}

export function markQueueItemPending(current: BatchQueueItem, stageKey: BatchQueueStageKey, stage: string): BatchQueueItem {
    return {
        ...current,
        status: 'pending',
        ...createStage(stageKey, stage),
        errorInfo: undefined
    };
}

export function markQueueItemStopped(current: BatchQueueItem, stage = '队列已停止，可继续处理'): BatchQueueItem {
    const finishedAt = Date.now();
    return {
        ...current,
        status: 'pending',
        ...createStage(BATCH_QUEUE_STAGE.stopped, stage),
        errorInfo: undefined,
        ...withElapsed(current, finishedAt)
    };
}

export function markQueueItemProcessing(current: BatchQueueItem, stageKey: BatchQueueStageKey, stage: string): BatchQueueItem {
    return {
        ...current,
        status: 'processing',
        ...createStage(stageKey, stage),
        errorInfo: undefined,
        startedAt: Date.now(),
        finishedAt: undefined,
        elapsedMs: undefined
    };
}

export function markQueueItemFailed(
    current: BatchQueueItem,
    errorInfo: StructuredErrorInfo,
    stage = '处理失败'
): BatchQueueItem {
    const finishedAt = Date.now();
    return {
        ...current,
        status: 'error',
        ...createStage(BATCH_QUEUE_STAGE.failed, stage),
        errorInfo,
        ...withElapsed(current, finishedAt)
    };
}

export function markQueueItemSucceeded(current: BatchQueueItem, outputPath: string, stage = '处理完成'): BatchQueueItem {
    const finishedAt = Date.now();
    return {
        ...current,
        status: 'success',
        ...createStage(BATCH_QUEUE_STAGE.completed, stage),
        outputPath,
        errorInfo: undefined,
        ...withElapsed(current, finishedAt)
    };
}

export function markQueueItemRetryWaiting(current: BatchQueueItem): BatchQueueItem {
    return {
        ...current,
        status: 'pending',
        ...createStage(BATCH_QUEUE_STAGE.retryWaiting, '等待重试'),
        errorInfo: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        elapsedMs: undefined
    };
}
