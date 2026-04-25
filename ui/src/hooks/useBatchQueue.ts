import { useEffect, useMemo, useRef, useState } from 'react';
import { buildBatchMatchKey, classifyBatchAsset, type BatchInputAsset } from '../utils/batchAssets';
import { isBackendCanceledError } from '../utils/backendCancellation';
import { cleanupSessionArtifacts } from '../utils/sessionCleanup';
import {
    markQueueItemFailed,
    markQueueItemPending,
    markQueueItemProcessing,
    markQueueItemRetryWaiting,
    markQueueItemStopped,
    markQueueItemSucceeded
} from '../utils/batchQueueTransitions';
import {
    BATCH_QUEUE_STAGE,
    createStage,
    pickNextPendingQueueItem,
    resolveItemOutputDir,
    type BatchQueueItem,
    type BatchQueueOptions,
    type BatchSubtitleGenerationOptions,
    type BatchSubtitleTranslationOptions,
    type PreparedBatchQueueItem
} from '../utils/batchQueueTypes';
import {
    buildQueueItemErrorInfo,
    finalizeQueueItem,
    prepareQueueItem,
    runBatchSubtitleGenerationQueue,
    runBatchSubtitleTranslationQueue,
} from '../utils/batchQueueService';
import { updateSessionManifest } from '../utils/sessionManifest';

export { BATCH_QUEUE_STAGE };
export type { BatchQueueItem };

const BATCH_QUEUE_ITEMS_STORAGE_KEY = 'batchQueue.items.v1';
const BATCH_QUEUE_META_STORAGE_KEY = 'batchQueue.meta.v1';
const DURATION_PROBE_CONCURRENCY = 2;

interface BatchQueuePersistedMeta {
    isRunning: boolean;
    activeItemId: string | null;
    queueStartedAt: number | null;
    queueFinishedElapsedMs: number;
}

interface BatchQueueBootstrapState {
    items: BatchQueueItem[];
    meta: BatchQueuePersistedMeta;
    shouldResume: boolean;
}

function readStoredQueueItems(): BatchQueueItem[] {
    try {
        const raw = localStorage.getItem(BATCH_QUEUE_ITEMS_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.map((item) => {
            const { error: _legacyError, ...rest } = item || {};
            return {
                ...rest,
                errorInfo: rest?.errorInfo && typeof rest.errorInfo === 'object' ? rest.errorInfo : undefined
            };
        });
    } catch {
        return [];
    }
}

function readStoredQueueMeta(): BatchQueuePersistedMeta {
    try {
        const raw = localStorage.getItem(BATCH_QUEUE_META_STORAGE_KEY);
        if (!raw) {
            return {
                isRunning: false,
                activeItemId: null,
                queueStartedAt: null,
                queueFinishedElapsedMs: 0
            };
        }
        const parsed = JSON.parse(raw);
        return {
            isRunning: Boolean(parsed?.isRunning),
            activeItemId: typeof parsed?.activeItemId === 'string' ? parsed.activeItemId : null,
            queueStartedAt: typeof parsed?.queueStartedAt === 'number' ? parsed.queueStartedAt : null,
            queueFinishedElapsedMs: typeof parsed?.queueFinishedElapsedMs === 'number' ? parsed.queueFinishedElapsedMs : 0
        };
    } catch {
        return {
            isRunning: false,
            activeItemId: null,
            queueStartedAt: null,
            queueFinishedElapsedMs: 0
        };
    }
}

function readBootstrapState(): BatchQueueBootstrapState {
    const storedItems = readStoredQueueItems();
    const storedMeta = readStoredQueueMeta();
    const hadInterruptedRun = storedMeta.isRunning;

    const normalizedItems = hadInterruptedRun
        ? storedItems.map(item => {
            if (item.status === 'processing') {
                return {
                    ...item,
                    status: 'pending' as const,
                    ...createStage(BATCH_QUEUE_STAGE.waiting, '等待处理'),
                    startedAt: undefined,
                    finishedAt: undefined,
                    elapsedMs: undefined
                };
            }
            return item;
        })
        : storedItems;

    return {
        items: normalizedItems,
        meta: hadInterruptedRun
            ? {
                ...storedMeta,
                isRunning: false,
                activeItemId: null
            }
            : storedMeta,
        shouldResume: hadInterruptedRun && normalizedItems.some(item => item.status === 'pending')
    };
}

interface UseBatchQueueOptions {
    outputDirOverride?: string;
}

export function useBatchQueue(_options: UseBatchQueueOptions = {}) {
    const bootstrapRef = useRef<BatchQueueBootstrapState>(readBootstrapState());
    const persistedMetaRef = useRef<BatchQueuePersistedMeta>(bootstrapRef.current.meta);
    const [items, setItems] = useState<BatchQueueItem[]>(() => bootstrapRef.current.items);
    const itemsRef = useRef<BatchQueueItem[]>(bootstrapRef.current.items);
    const [isRunning, setIsRunning] = useState(() => persistedMetaRef.current.isRunning);
    const [activeItemId, setActiveItemId] = useState<string | null>(() => persistedMetaRef.current.activeItemId);
    const activeItemIdRef = useRef<string | null>(persistedMetaRef.current.activeItemId);
    const [now, setNow] = useState(() => Date.now());
    const stopRequestedRef = useRef(false);
    const runLockRef = useRef(false);
    const pendingSubtitleAssetsRef = useRef<BatchInputAsset[]>([]);
    const durationProbeQueueRef = useRef<Array<{ id: string; path: string }>>([]);
    const durationProbeActiveCountRef = useRef(0);
    const durationProbeTimerRef = useRef<number | null>(null);
    const [queueStartedAt, setQueueStartedAt] = useState<number | null>(() => persistedMetaRef.current.queueStartedAt);
    const [queueFinishedElapsedMs, setQueueFinishedElapsedMs] = useState(() => persistedMetaRef.current.queueFinishedElapsedMs);
    const [shouldResume, setShouldResume] = useState(() => bootstrapRef.current.shouldResume);
    const [unmatchedSubtitleAssets, setUnmatchedSubtitleAssets] = useState<BatchInputAsset[]>([]);

    useEffect(() => {
        if (!isRunning) return;

        const timer = window.setInterval(() => {
            setNow(Date.now());
        }, 1000);

        return () => window.clearInterval(timer);
    }, [isRunning]);

    useEffect(() => {
        itemsRef.current = items;
    }, [items]);

    useEffect(() => {
        activeItemIdRef.current = activeItemId;
    }, [activeItemId]);

    useEffect(() => {
        try {
            localStorage.setItem(BATCH_QUEUE_ITEMS_STORAGE_KEY, JSON.stringify(items));
        } catch (error) {
            console.error('Failed to persist batch queue items:', error);
        }
    }, [items]);

    useEffect(() => {
        try {
            const meta: BatchQueuePersistedMeta = {
                isRunning,
                activeItemId,
                queueStartedAt,
                queueFinishedElapsedMs
            };
            localStorage.setItem(BATCH_QUEUE_META_STORAGE_KEY, JSON.stringify(meta));
        } catch (error) {
            console.error('Failed to persist batch queue meta:', error);
        }
    }, [activeItemId, isRunning, queueFinishedElapsedMs, queueStartedAt]);

    const summary = useMemo(() => {
        const pending = items.filter(item => item.status === 'pending').length;
        const processing = items.filter(item => item.status === 'processing').length;
        const success = items.filter(item => item.status === 'success').length;
        const error = items.filter(item => item.status === 'error').length;
        const canceled = items.filter(item => item.status === 'canceled').length;
        const totalSourceDurationSec = items.reduce((sum, item) => sum + (item.sourceDurationSec || 0), 0);
        const totalElapsedMs = queueStartedAt && isRunning
            ? Math.max(0, now - queueStartedAt)
            : queueFinishedElapsedMs;
        return {
            total: items.length,
            pending,
            processing,
            success,
            error,
            canceled,
            totalSourceDurationSec,
            totalElapsedMs,
            nowEpochMs: now
        };
    }, [isRunning, items, now, queueFinishedElapsedMs, queueStartedAt]);

    const updateItem = (id: string, updater: (item: BatchQueueItem) => BatchQueueItem) => {
        setItems(prev => prev.map(item => item.id === id ? updater(item) : item));
    };

    const applySubtitleAssetToItem = (
        item: BatchQueueItem,
        asset: BatchInputAsset,
        kind: Extract<ReturnType<typeof classifyBatchAsset>, 'subtitle-original' | 'subtitle-translated'>
    ) => {
        if (kind === 'subtitle-original') {
            item.originalSubtitlePath = asset.path;
            item.originalSubtitleContent = asset.textContent;
            return;
        }

        item.translatedSubtitlePath = asset.path;
        item.translatedSubtitleContent = asset.textContent;
    };

    const resolveSubtitleAssetKind = (
        asset: BatchInputAsset
    ): Extract<ReturnType<typeof classifyBatchAsset>, 'subtitle-original' | 'subtitle-translated'> => {
        const kind = classifyBatchAsset(asset);
        return kind === 'subtitle-translated' ? 'subtitle-translated' : 'subtitle-original';
    };

    const clearDurationProbeTimer = () => {
        if (durationProbeTimerRef.current !== null) {
            window.clearTimeout(durationProbeTimerRef.current);
            durationProbeTimerRef.current = null;
        }
    };

    const isDurationProbeEligible = (task: { id: string; path: string }) => (
        itemsRef.current.some(item => item.id === task.id && !item.sourceDurationSec)
    );

    const scheduleDurationProbe = (delayMs = 250) => {
        if (durationProbeTimerRef.current !== null) return;
        durationProbeTimerRef.current = window.setTimeout(() => {
            durationProbeTimerRef.current = null;
            void runDurationProbeQueue();
        }, delayMs);
    };

    const enqueueDurationProbes = (tasks: Array<{ id: string; path: string }>) => {
        if (tasks.length === 0) return;

        const queuedIds = new Set(durationProbeQueueRef.current.map(task => task.id));
        for (const task of tasks) {
            if (queuedIds.has(task.id) || !isDurationProbeEligible(task)) continue;
            durationProbeQueueRef.current.push(task);
            queuedIds.add(task.id);
        }

        pumpDurationProbeQueue();
    };

    const pumpDurationProbeQueue = (delayMs = 250) => {
        if (durationProbeQueueRef.current.length === 0) return;
        if (durationProbeActiveCountRef.current >= DURATION_PROBE_CONCURRENCY) return;
        scheduleDurationProbe(delayMs);
    };

    const runDurationProbeQueue = async () => {
        while (
            durationProbeActiveCountRef.current < DURATION_PROBE_CONCURRENCY &&
            durationProbeQueueRef.current.length > 0
        ) {
            const task = durationProbeQueueRef.current.shift();
            if (!task || !isDurationProbeEligible(task)) {
                continue;
            }

            durationProbeActiveCountRef.current += 1;
            void window.api.analyzeVideoMetadata(task.path)
                .then(result => {
                    if (result?.success && result.info?.duration) {
                        updateItem(task.id, current => ({
                            ...current,
                            sourceDurationSec: Number(result.info.duration) || 0
                        }));
                    }
                })
                .catch(error => {
                    console.error('Failed to analyze batch video duration:', task.path, error);
                })
                .finally(() => {
                    durationProbeActiveCountRef.current = Math.max(0, durationProbeActiveCountRef.current - 1);
                    pumpDurationProbeQueue(50);
                });
        }
    };

    const addAssets = async (assets: BatchInputAsset[]) => {
        if (assets.length === 0) return;

        const newlyAddedVideos: Array<{ id: string; path: string }> = [];
        const next = [...itemsRef.current];
        const bySource = new Map(next.map(item => [item.sourcePath.toLowerCase(), item]));
        const byMatchKey = new Map(next.map(item => [buildBatchMatchKey(item.fileName), item]));
        const subtitleAssets = [...pendingSubtitleAssetsRef.current];

        for (const asset of assets) {
            const kind = classifyBatchAsset(asset);
            if (kind === 'video') {
                if (bySource.has(asset.path.toLowerCase())) continue;

                const item: BatchQueueItem = {
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    sourcePath: asset.path,
                    fileName: asset.name,
                    resolvedOutputDir: _options.outputDirOverride?.trim() || undefined,
                    status: 'pending',
                    ...createStage(BATCH_QUEUE_STAGE.waiting, '等待处理')
                };
                next.push(item);
                newlyAddedVideos.push({ id: item.id, path: item.sourcePath });
                bySource.set(asset.path.toLowerCase(), item);
                byMatchKey.set(buildBatchMatchKey(asset.name), item);
            } else if (kind === 'subtitle-original' || kind === 'subtitle-translated') {
                subtitleAssets.push(asset);
            }
        }

        const unresolved: BatchInputAsset[] = [];
        for (const asset of subtitleAssets) {
            const kind = resolveSubtitleAssetKind(asset);
            const matchedItem = byMatchKey.get(buildBatchMatchKey(asset.name));
            if (!matchedItem) {
                unresolved.push(asset);
                continue;
            }

            applySubtitleAssetToItem(matchedItem, asset, kind);
        }

        pendingSubtitleAssetsRef.current = unresolved;
        setUnmatchedSubtitleAssets(unresolved);
        itemsRef.current = next;
        setItems([...next]);
        enqueueDurationProbes(newlyAddedVideos);
    };

    const assignUnmatchedSubtitle = (
        assetPath: string,
        itemId: string,
        kind: Extract<ReturnType<typeof classifyBatchAsset>, 'subtitle-original' | 'subtitle-translated'>
    ) => {
        const asset = pendingSubtitleAssetsRef.current.find(current => current.path === assetPath);
        if (!asset) return;

        const nextItems = itemsRef.current.map(item => {
            if (item.id !== itemId) return item;
            const cloned = { ...item };
            applySubtitleAssetToItem(cloned, asset, kind);
            return cloned;
        });

        const nextUnmatched = pendingSubtitleAssetsRef.current.filter(current => current.path !== assetPath);
        pendingSubtitleAssetsRef.current = nextUnmatched;
        setUnmatchedSubtitleAssets(nextUnmatched);
        itemsRef.current = nextItems;
        setItems(nextItems);
    };

    const removeUnmatchedSubtitle = (assetPath: string) => {
        const nextUnmatched = pendingSubtitleAssetsRef.current.filter(current => current.path !== assetPath);
        pendingSubtitleAssetsRef.current = nextUnmatched;
        setUnmatchedSubtitleAssets(nextUnmatched);
    };

    const removeItem = (id: string) => {
        durationProbeQueueRef.current = durationProbeQueueRef.current.filter(task => task.id !== id);
        setItems(prev => prev.filter(item => item.id !== id || item.status === 'processing'));
    };

    const clearCompleted = () => {
        const activeIds = new Set(itemsRef.current
            .filter(item => item.status === 'pending' || item.status === 'processing')
            .map(item => item.id));
        durationProbeQueueRef.current = durationProbeQueueRef.current.filter(task => activeIds.has(task.id));
        setItems(prev => prev.filter(item => item.status === 'pending' || item.status === 'processing'));
    };

    const clearAll = () => {
        pendingSubtitleAssetsRef.current = [];
        setUnmatchedSubtitleAssets([]);
        durationProbeQueueRef.current = [];
        clearDurationProbeTimer();
        setItems([]);
        itemsRef.current = [];
        setActiveItemId(null);
        activeItemIdRef.current = null;
        setQueueStartedAt(null);
        setQueueFinishedElapsedMs(0);
        setShouldResume(false);
        setNow(Date.now());
    };

    const retryFailed = () => {
        setItems(prev => {
            const retryItems: BatchQueueItem[] = [];
            const remainingItems: BatchQueueItem[] = [];

            for (const item of prev) {
                if (item.status === 'error' || item.status === 'canceled') {
                    retryItems.push(markQueueItemRetryWaiting(item));
                } else {
                    remainingItems.push(item);
                }
            }

            return [...remainingItems, ...retryItems];
        });
    };

    const openOutput = async (item: BatchQueueItem) => {
        const outputRoot = resolveItemOutputDir(item, _options.outputDirOverride);
        const targetPath = item.outputPath || outputRoot;
        if (!targetPath) return;
        try {
            await window.api.openFolder(targetPath);
        } catch (error) {
            console.error('Failed to open output folder:', error);
        }
    };

    const stopQueue = async (setStatus: (value: string) => void) => {
        stopRequestedRef.current = true;
        setShouldResume(false);
        const stoppedAt = Date.now();

        const nextItems = itemsRef.current.map(item => {
            if (item.status === 'processing' || item.status === 'pending') {
                const next = markQueueItemStopped(item, '队列已停止，可继续处理');
                return {
                    ...next,
                    finishedAt: item.finishedAt ?? stoppedAt,
                    elapsedMs: item.startedAt ? Math.max(0, stoppedAt - item.startedAt) : item.elapsedMs
                };
            }
            return item;
        });

        itemsRef.current = nextItems;
        setItems(nextItems);
        setActiveItemId(null);
        activeItemIdRef.current = null;
        setIsRunning(false);
        runLockRef.current = false;
        if (queueStartedAt) {
            setQueueFinishedElapsedMs(Math.max(0, stoppedAt - queueStartedAt));
        }
        setNow(stoppedAt);
        setStatus('正在停止批量任务...');

        try {
            await window.api.killBackend();
        } catch (error) {
            console.error('Failed to stop queue backend process:', error);
        }

        setStatus('批量任务已停止，可再次启动继续处理。');
    };

    const startQueue = async (options: BatchQueueOptions) => {
        if (runLockRef.current) return;

        const pendingCount = itemsRef.current.filter(item => item.status === 'pending').length;
        if (pendingCount === 0 || isRunning) return;

        runLockRef.current = true;

        const queueStartTime = Date.now();
        setIsRunning(true);
        setNow(queueStartTime);
        setQueueStartedAt(queueStartTime);
        setQueueFinishedElapsedMs(0);
        stopRequestedRef.current = false;
        options.setStatus(`批量任务启动，共 ${pendingCount} 个文件待处理`);

        const startPreparation = async (item: BatchQueueItem) => {
            if (stopRequestedRef.current) return null;

            updateItem(item.id, current => ({
                ...current,
                finishedAt: undefined,
                elapsedMs: undefined
            }));
            updateItem(item.id, current => markQueueItemPending(current, BATCH_QUEUE_STAGE.preparing, '准备处理中'));

            try {
                const prepared = await prepareQueueItem(item, options, stage => {
                    updateItem(item.id, current => ({ ...current, stage }));
                }, patch => {
                    updateItem(item.id, current => ({ ...current, ...patch }));
                });
                return { item, prepared };
            } catch (error: any) {
                if (stopRequestedRef.current || isBackendCanceledError(error)) {
                    updateItem(item.id, current => markQueueItemStopped(current, '队列已停止，可继续处理'));
                    return null;
                }

                updateItem(item.id, current => markQueueItemFailed(
                    current,
                    buildQueueItemErrorInfo(error, '处理失败'),
                    '处理失败'
                ));
                return null;
            }
        };

        const finalizePreparedItem = async (
            preparedEntry: { item: BatchQueueItem; prepared: PreparedBatchQueueItem }
        ) => {
            const { item, prepared } = preparedEntry;

            if (stopRequestedRef.current) {
                await cleanupSessionArtifacts(prepared.projectPaths, 'interrupted');
                updateItem(item.id, current => markQueueItemStopped(current, '队列已停止，可继续处理'));
                return;
            }

            setActiveItemId(item.id);
            try {
                updateItem(item.id, current => markQueueItemProcessing(current, BATCH_QUEUE_STAGE.fullFlow, current.stage || '处理中'));

                const outputPath = await finalizeQueueItem(item, prepared, options, stage => {
                    updateItem(item.id, current => ({ ...current, stage }));
                    options.setStatus(`批量处理中：${item.fileName} - ${stage}`);
                });

                if (stopRequestedRef.current) {
                    await cleanupSessionArtifacts(prepared.projectPaths, 'interrupted');
                    updateItem(item.id, current => markQueueItemStopped(current, '队列已停止，可继续处理'));
                } else {
                    updateItem(item.id, current => markQueueItemSucceeded(current, outputPath, '处理完成'));
                }
            } catch (error: any) {
                if (stopRequestedRef.current || isBackendCanceledError(error)) {
                    await updateSessionManifest(prepared.projectPaths, {
                        phase: 'interrupted',
                        currentStage: '用户中断批量任务',
                        resume: {
                            recoverable: true
                        },
                        lastError: {
                            code: 'QUEUE_INTERRUPTED',
                            message: '任务被用户中断',
                            stage: 'queue',
                            retryable: true
                        }
                    }).catch(() => undefined);
                    await cleanupSessionArtifacts(prepared.projectPaths, 'interrupted');
                    updateItem(item.id, current => markQueueItemStopped(current, '队列已停止，可继续处理'));
                } else {
                    await updateSessionManifest(prepared.projectPaths, {
                        phase: 'failed',
                        currentStage: '批量任务失败',
                        resume: {
                            recoverable: true
                        },
                        lastError: {
                            code: 'QUEUE_ITEM_FAILED',
                            message: error?.message || String(error),
                            stage: 'queue',
                            retryable: true
                        }
                    }).catch(() => undefined);
                    await cleanupSessionArtifacts(prepared.projectPaths, 'failed');
                    updateItem(item.id, current => markQueueItemFailed(
                        current,
                        buildQueueItemErrorInfo(error, '处理失败'),
                        '处理失败'
                    ));
                }
            }
        };

        try {
            while (!stopRequestedRef.current) {
                const nextPendingItem = pickNextPendingQueueItem(itemsRef.current);
                if (!nextPendingItem) {
                    break;
                }

                const preparedEntry = await startPreparation(nextPendingItem);
                if (!preparedEntry) {
                    continue;
                }

                await finalizePreparedItem(preparedEntry);
            }
        } finally {
            const wasStopped = stopRequestedRef.current;
            setQueueFinishedElapsedMs(Math.max(0, Date.now() - queueStartTime));
            setActiveItemId(null);
            activeItemIdRef.current = null;
            setIsRunning(false);
            setNow(Date.now());
            stopRequestedRef.current = false;
            runLockRef.current = false;
            if (!wasStopped) {
                options.setStatus('批量任务已结束');
            }
        }
    };

    const generateMissingSubtitles = async (options: BatchSubtitleGenerationOptions) => {
        if (runLockRef.current || isRunning) return;

        const eligibleItems = itemsRef.current.filter(item => item.status !== 'success');
        const missingSubtitleItems = eligibleItems.filter(item => !item.originalSubtitleContent);
        const queue = missingSubtitleItems.length > 0 ? missingSubtitleItems : eligibleItems;
        if (queue.length === 0) {
            options.setStatus('当前没有可执行字幕识别的批量任务。');
            return;
        }

        runLockRef.current = true;
        const startedAt = Date.now();
        setIsRunning(true);
        setQueueStartedAt(startedAt);
        setQueueFinishedElapsedMs(0);
        setNow(startedAt);
        stopRequestedRef.current = false;
        let successCount = 0;
        let failedCount = 0;
        const isRerun = missingSubtitleItems.length === 0;
        options.setStatus(
            isRerun
                ? `正在重新识别全部 ${queue.length} 个任务的原字幕...`
                : `开始识别缺失原字幕的 ${queue.length} 个任务...`
        );

        try {
            const summary = await runBatchSubtitleGenerationQueue({
                queue,
                options,
                isStopped: () => stopRequestedRef.current,
                isCanceledError: isBackendCanceledError,
                onActivateItem: (itemId) => {
                    setActiveItemId(itemId);
                    activeItemIdRef.current = itemId;
                    const activeItem = itemId ? itemsRef.current.find(item => item.id === itemId) : null;
                    if (activeItem) {
                        options.setStatus(
                            isRerun
                                ? `正在重新识别字幕：${activeItem.fileName}`
                                : `正在识别字幕：${activeItem.fileName}`
                        );
                    }
                },
                onItemUpdate: (itemId, updater) => updateItem(itemId, updater)
            });
            successCount = summary.successCount;
            failedCount = summary.failedCount;
        } finally {
            const elapsed = Math.max(0, Date.now() - startedAt);
            const wasStopped = stopRequestedRef.current;
            setActiveItemId(null);
            activeItemIdRef.current = null;
            setIsRunning(false);
            setQueueFinishedElapsedMs(elapsed);
            setNow(Date.now());
            runLockRef.current = false;
            stopRequestedRef.current = false;
            if (wasStopped) {
                options.setStatus('批量字幕识别已停止，可再次启动继续处理。');
            } else {
                options.setStatus(
                    `${isRerun ? '字幕重新识别' : '字幕识别'}已完成，耗时 ${Math.floor(elapsed / 1000)} 秒。成功 ${successCount} 项，失败 ${failedCount} 项，跳过 ${Math.max(0, queue.length - successCount - failedCount)} 项。`
                );
            }
        }
    };

    const generateTranslatedSubtitles = async (options: BatchSubtitleTranslationOptions) => {
        if (runLockRef.current || isRunning) return;

        const eligibleItems = itemsRef.current.filter(item => item.status !== 'success');
        const translatableItems = eligibleItems.filter(item => item.originalSubtitleContent);
        const missingTranslatedItems = translatableItems.filter(item => !item.translatedSubtitleContent);
        const queue = missingTranslatedItems.length > 0 ? missingTranslatedItems : translatableItems;

        if (translatableItems.length === 0) {
            options.setStatus('当前没有可执行字幕翻译的批量任务。请先生成或导入原字幕。');
            return;
        }

        if (queue.length === 0) {
            options.setStatus('当前没有需要翻译的批量任务。');
            return;
        }

        runLockRef.current = true;
        const startedAt = Date.now();
        setIsRunning(true);
        setQueueStartedAt(startedAt);
        setQueueFinishedElapsedMs(0);
        setNow(startedAt);
        stopRequestedRef.current = false;
        let successCount = 0;
        let failedCount = 0;
        const isRerun = missingTranslatedItems.length === 0;
        options.setStatus(
            isRerun
                ? `正在重新翻译全部 ${queue.length} 个任务的字幕...`
                : `开始翻译缺失字幕的 ${queue.length} 个任务...`
        );

        try {
            const summary = await runBatchSubtitleTranslationQueue({
                queue,
                options,
                isStopped: () => stopRequestedRef.current,
                isCanceledError: isBackendCanceledError,
                onActivateItem: (itemId) => {
                    setActiveItemId(itemId);
                    activeItemIdRef.current = itemId;
                    const activeItem = itemId ? itemsRef.current.find(item => item.id === itemId) : null;
                    if (activeItem) {
                        options.setStatus(
                            isRerun
                                ? `正在重新翻译字幕：${activeItem.fileName}`
                                : `正在翻译字幕：${activeItem.fileName}`
                        );
                    }
                },
                onItemUpdate: (itemId, updater) => updateItem(itemId, updater)
            });
            successCount = summary.successCount;
            failedCount = summary.failedCount;
        } finally {
            const elapsed = Math.max(0, Date.now() - startedAt);
            const wasStopped = stopRequestedRef.current;
            setActiveItemId(null);
            activeItemIdRef.current = null;
            setIsRunning(false);
            setQueueFinishedElapsedMs(elapsed);
            setNow(Date.now());
            runLockRef.current = false;
            stopRequestedRef.current = false;
            if (wasStopped) {
                options.setStatus('批量字幕翻译已停止，可再次启动继续处理。');
            } else {
                options.setStatus(
                    `${isRerun ? '字幕重新翻译' : '字幕翻译'}已完成，耗时 ${Math.floor(elapsed / 1000)} 秒。成功 ${successCount} 项，失败 ${failedCount} 项，跳过 ${Math.max(0, queue.length - successCount - failedCount)} 项。`
                );
            }
        }
    };

    useEffect(() => {
        const missingDurationItems = itemsRef.current
            .filter(item => !item.sourceDurationSec)
            .map(item => ({ id: item.id, path: item.sourcePath }));
        enqueueDurationProbes(missingDurationItems);

        return () => {
            clearDurationProbeTimer();
        };
    }, []);

    return {
        items,
        unmatchedSubtitleAssets,
        summary,
        isRunning,
        shouldResume,
        activeItemId,
        addAssets,
        assignUnmatchedSubtitle,
        removeUnmatchedSubtitle,
        removeItem,
        clearCompleted,
        clearAll,
        acknowledgeResume: () => setShouldResume(false),
        retryFailed,
        openOutput,
        generateMissingSubtitles,
        generateTranslatedSubtitles,
        startQueue,
        stopQueue
    };
}
