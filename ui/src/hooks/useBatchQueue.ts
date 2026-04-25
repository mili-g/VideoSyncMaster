import { useEffect, useMemo, useRef, useState } from 'react';
import { buildBatchMatchKey, classifyBatchAsset, type BatchInputAsset } from '../utils/batchAssets';
import { parseSRTContent, segmentsToSRT, type SrtSegment } from '../utils/srt';
import { cleanupOutputArtifacts, saveSubtitleArtifacts } from '../utils/outputArtifacts';
import { prepareBatchProjectPaths } from '../utils/projectPaths';
import { isBackendCanceledError } from '../utils/backendCancellation';
import { appendStoredTranslationArgs, getStoredQwenTtsSettings, getStoredWhisperVadSettings } from '../utils/runtimeSettings';

const BATCH_QUEUE_ITEMS_STORAGE_KEY = 'batchQueue.items.v1';
const BATCH_QUEUE_META_STORAGE_KEY = 'batchQueue.meta.v1';
const DURATION_PROBE_CONCURRENCY = 2;

export type BatchQueueStatus = 'pending' | 'processing' | 'success' | 'error' | 'canceled';

export interface BatchQueueItem {
    id: string;
    sourcePath: string;
    fileName: string;
    resolvedOutputDir?: string;
    sourceDurationSec?: number;
    originalSubtitlePath?: string;
    originalSubtitleContent?: string;
    translatedSubtitlePath?: string;
    translatedSubtitleContent?: string;
    status: BatchQueueStatus;
    stage: string;
    stageKey?: string;
    outputPath?: string;
    error?: string;
    startedAt?: number;
    finishedAt?: number;
    elapsedMs?: number;
}

export const BATCH_QUEUE_STAGE = {
    idle: 'idle',
    waiting: 'waiting',
    retryWaiting: 'retry-waiting',
    stopped: 'stopped',
    preparing: 'preparing',
    preparingOutput: 'preparing-output',
    fullFlow: 'full-flow',
    savingSourceSubtitles: 'saving-source-subtitles',
    loadingTranslatedSubtitles: 'loading-translated-subtitles',
    translatingSubtitles: 'translating-subtitles',
    generatingDubbing: 'generating-dubbing',
    retryingFailedSegments: 'retrying-failed-segments',
    partialMerge: 'partial-merge',
    mergingVideo: 'merging-video',
    completed: 'completed',
    failed: 'failed',
    sourceSubtitleGenerating: 'source-subtitle-generating',
    sourceSubtitleReady: 'source-subtitle-ready',
    sourceSubtitleRefreshed: 'source-subtitle-refreshed',
    sourceSubtitleFailed: 'source-subtitle-failed',
    translatedSubtitleReady: 'translated-subtitle-ready',
    translatedSubtitleRefreshed: 'translated-subtitle-refreshed',
    translatedSubtitleFailed: 'translated-subtitle-failed'
} as const;

type BatchQueueStageKey = typeof BATCH_QUEUE_STAGE[keyof typeof BATCH_QUEUE_STAGE];

function createStage(stageKey: BatchQueueStageKey, stage: string) {
    return { stageKey, stage };
}

interface BatchQueueOptions {
    outputDirOverride?: string;
    targetLang: string;
    asrService: string;
    ttsService: 'indextts' | 'qwen';
    asrOriLang: string;
    videoStrategy: string;
    audioMixMode: 'preserve_background' | 'replace_original';
    batchSize: number;
    cloneBatchSize: number;
    maxNewTokens: number;
    setStatus: (value: string) => void;
}

interface BatchSubtitleGenerationOptions {
    outputDirOverride?: string;
    asrService: string;
    asrOriLang: string;
    setStatus: (value: string) => void;
}

interface BatchSubtitleTranslationOptions {
    outputDirOverride?: string;
    targetLang: string;
    setStatus: (value: string) => void;
}

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
        return Array.isArray(parsed) ? parsed : [];
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

function resolveItemOutputDir(item: Pick<BatchQueueItem, 'resolvedOutputDir'>, outputDirOverride?: string) {
    return item.resolvedOutputDir?.trim() || outputDirOverride;
}

function pickNextPendingQueueItem(items: BatchQueueItem[]) {
    return items.find(item => (
        item.status === 'pending' && item.stageKey === BATCH_QUEUE_STAGE.retryWaiting
    )) || items.find(item => item.status === 'pending');
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
                    retryItems.push({
                        ...item,
                        status: 'pending',
                        ...createStage(BATCH_QUEUE_STAGE.retryWaiting, '等待重试'),
                        error: undefined,
                        startedAt: undefined,
                        finishedAt: undefined,
                        elapsedMs: undefined
                    });
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
                return {
                    ...item,
                    status: 'pending' as const,
                    ...createStage(BATCH_QUEUE_STAGE.stopped, '队列已停止，可继续处理'),
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
            updateItem(item.id, current => ({
                ...current,
                ...createStage(BATCH_QUEUE_STAGE.preparing, '准备处理中'),
                error: undefined
            }));

            try {
                const prepared = await prepareQueueItem(item, options, stage => {
                    updateItem(item.id, current => ({ ...current, stage }));
                }, patch => {
                    updateItem(item.id, current => ({ ...current, ...patch }));
                });
                return { item, prepared };
            } catch (error: any) {
                if (stopRequestedRef.current || isBackendCanceledError(error)) {
                    updateItem(item.id, current => ({
                        ...current,
                        status: 'pending',
                        ...createStage(BATCH_QUEUE_STAGE.stopped, '队列已停止，可继续处理')
                    }));
                    return null;
                }

                updateItem(item.id, current => ({
                    ...current,
                    status: 'error',
                    ...createStage(BATCH_QUEUE_STAGE.failed, '处理失败'),
                    error: error?.message || String(error),
                    finishedAt: Date.now(),
                    elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
                }));
                return null;
            }
        };

        const finalizePreparedItem = async (
            preparedEntry: { item: BatchQueueItem; prepared: PreparedBatchQueueItem }
        ) => {
            const { item, prepared } = preparedEntry;

            if (stopRequestedRef.current) {
                updateItem(item.id, current => ({
                    ...current,
                    status: 'pending',
                    ...createStage(BATCH_QUEUE_STAGE.stopped, '队列已停止，可继续处理')
                }));
                return;
            }

            setActiveItemId(item.id);
            try {
                const itemStartedAt = Date.now();
                updateItem(item.id, current => ({
                    ...current,
                    status: 'processing',
                    startedAt: itemStartedAt,
                    finishedAt: undefined,
                    elapsedMs: undefined
                }));

                const outputPath = await finalizeQueueItem(item, prepared, options, stage => {
                    updateItem(item.id, current => ({ ...current, stage }));
                    options.setStatus(`批量处理中：${item.fileName} - ${stage}`);
                });

                if (stopRequestedRef.current) {
                    updateItem(item.id, current => ({
                        ...current,
                        status: 'pending',
                        ...createStage(BATCH_QUEUE_STAGE.stopped, '队列已停止，可继续处理')
                    }));
                } else {
                    updateItem(item.id, current => ({
                        ...current,
                        status: 'success',
                        ...createStage(BATCH_QUEUE_STAGE.completed, '处理完成'),
                        outputPath,
                        error: undefined,
                        finishedAt: Date.now(),
                        elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
                    }));
                }
            } catch (error: any) {
                if (stopRequestedRef.current || isBackendCanceledError(error)) {
                    updateItem(item.id, current => ({
                        ...current,
                        status: 'pending',
                        ...createStage(BATCH_QUEUE_STAGE.stopped, '队列已停止，可继续处理')
                    }));
                } else {
                    updateItem(item.id, current => ({
                        ...current,
                        status: 'error',
                        ...createStage(BATCH_QUEUE_STAGE.failed, '处理失败'),
                        error: error?.message || String(error),
                        finishedAt: Date.now(),
                        elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
                    }));
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
            for (const item of queue) {
                if (stopRequestedRef.current) {
                    break;
                }

                const itemStartedAt = Date.now();
                setActiveItemId(item.id);
                updateItem(item.id, current => ({
                    ...current,
                    status: 'processing',
                    ...createStage(BATCH_QUEUE_STAGE.sourceSubtitleGenerating, '正在识别原字幕'),
                    error: undefined,
                    startedAt: itemStartedAt,
                    finishedAt: undefined,
                    elapsedMs: undefined
                }));
                options.setStatus(
                    isRerun
                        ? `正在重新识别字幕：${item.fileName}`
                        : `正在识别字幕：${item.fileName}`
                );

                try {
                    const { outputDir, subtitlePath, subtitleContent } = await generateSubtitleForItem(item, options);
                    if (stopRequestedRef.current) {
                        updateItem(item.id, current => ({
                            ...current,
                            status: 'pending',
                            ...createStage(BATCH_QUEUE_STAGE.stopped, '队列已停止，可继续识别或开始批量处理'),
                            finishedAt: Date.now(),
                            elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
                        }));
                        continue;
                    }
                    successCount += 1;

                    updateItem(item.id, current => ({
                        ...current,
                        status: 'pending',
                        ...createStage(
                            isRerun ? BATCH_QUEUE_STAGE.sourceSubtitleRefreshed : BATCH_QUEUE_STAGE.sourceSubtitleReady,
                            isRerun ? '原字幕已刷新，可继续批量处理' : '原字幕已生成，可继续批量处理'
                        ),
                        resolvedOutputDir: outputDir,
                        originalSubtitlePath: subtitlePath,
                        originalSubtitleContent: subtitleContent,
                        error: undefined,
                        finishedAt: Date.now(),
                        elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
                    }));
                } catch (error: any) {
                    if (stopRequestedRef.current || isBackendCanceledError(error)) {
                        updateItem(item.id, current => ({
                            ...current,
                            status: 'pending',
                            ...createStage(BATCH_QUEUE_STAGE.stopped, '队列已停止，可继续识别或开始批量处理'),
                            error: undefined,
                            finishedAt: Date.now(),
                            elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
                        }));
                        continue;
                    }
                    failedCount += 1;
                    updateItem(item.id, current => ({
                        ...current,
                        status: 'pending',
                        ...createStage(BATCH_QUEUE_STAGE.sourceSubtitleFailed, '字幕识别失败，可稍后重试或直接继续完整流程'),
                        error: error?.message || String(error),
                        finishedAt: Date.now(),
                        elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
                    }));
                }
            }
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
            for (const item of queue) {
                if (stopRequestedRef.current) {
                    break;
                }

                const itemStartedAt = Date.now();
                setActiveItemId(item.id);
                updateItem(item.id, current => ({
                    ...current,
                    status: 'processing',
                    ...createStage(BATCH_QUEUE_STAGE.translatingSubtitles, '正在翻译字幕'),
                    error: undefined,
                    startedAt: itemStartedAt,
                    finishedAt: undefined,
                    elapsedMs: undefined
                }));
                options.setStatus(
                    isRerun
                        ? `正在重新翻译字幕：${item.fileName}`
                        : `正在翻译字幕：${item.fileName}`
                );

                try {
                    const { projectPaths } = await prepareBatchProjectPaths(
                        item.fileName,
                        item.id,
                        resolveItemOutputDir(item, options.outputDirOverride)
                    );
                    const sourceSegments = resolveSourceSegments(item);
                    if (sourceSegments.length === 0) {
                        throw new Error('缺少可翻译的原字幕内容');
                    }

                    const translatedSegments = await translateSegments(sourceSegments, options);
                    const translatedSubtitleContent = segmentsToSRT(translatedSegments);
                    await saveSubtitleArtifacts(projectPaths.finalDir, item.fileName, sourceSegments, translatedSegments);

                    if (stopRequestedRef.current) {
                        updateItem(item.id, current => ({
                            ...current,
                            status: 'pending',
                            ...createStage(BATCH_QUEUE_STAGE.stopped, '队列已停止，可继续翻译或开始批量处理'),
                            finishedAt: Date.now(),
                            elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
                        }));
                        continue;
                    }

                    successCount += 1;
                    updateItem(item.id, current => ({
                        ...current,
                        status: 'pending',
                        ...createStage(
                            isRerun ? BATCH_QUEUE_STAGE.translatedSubtitleRefreshed : BATCH_QUEUE_STAGE.translatedSubtitleReady,
                            isRerun ? '翻译字幕已刷新，可继续批量处理' : '翻译字幕已生成，可继续批量处理'
                        ),
                        resolvedOutputDir: projectPaths.outputDir,
                        translatedSubtitlePath: projectPaths.translatedSubtitlePath,
                        translatedSubtitleContent,
                        error: undefined,
                        finishedAt: Date.now(),
                        elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
                    }));
                } catch (error: any) {
                    if (stopRequestedRef.current || isBackendCanceledError(error)) {
                        updateItem(item.id, current => ({
                            ...current,
                            status: 'pending',
                            ...createStage(BATCH_QUEUE_STAGE.stopped, '队列已停止，可继续翻译或开始批量处理'),
                            error: undefined,
                            finishedAt: Date.now(),
                            elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
                        }));
                        continue;
                    }

                    failedCount += 1;
                    updateItem(item.id, current => ({
                        ...current,
                        status: 'pending',
                        ...createStage(BATCH_QUEUE_STAGE.translatedSubtitleFailed, '字幕翻译失败，可稍后重试或继续完整流程'),
                        error: error?.message || String(error),
                        finishedAt: Date.now(),
                        elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
                    }));
                }
            }
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

async function generateSubtitleForItem(
    item: BatchQueueItem,
    options: BatchSubtitleGenerationOptions
) {
    const { projectPaths } = await prepareBatchProjectPaths(
        item.fileName,
        item.id,
        resolveItemOutputDir(item, options.outputDirOverride)
    );
    const vad = getStoredWhisperVadSettings();

    const args = [
        '--action', 'test_asr',
        '--input', item.sourcePath,
        '--asr', options.asrService,
        '--output_dir', projectPaths.sessionTempDir,
        '--vad_onset', vad.onset,
        '--vad_offset', vad.offset,
        '--json'
    ];

    if (options.asrOriLang) {
        args.push('--ori_lang', options.asrOriLang);
    }

    const result = await window.api.runBackend(args, { lane: 'prep' });
    if (!Array.isArray(result) || result.length === 0) {
        throw new Error('语音识别未返回有效字幕片段。');
    }

    const subtitleContent = segmentsToSRT(result);
    await window.api.saveFile(projectPaths.originalSubtitlePath, subtitleContent);
    return {
        outputDir: projectPaths.outputDir,
        subtitlePath: projectPaths.originalSubtitlePath,
        subtitleContent
    };
}

interface PreparedBatchQueueItem {
    outputPath: string;
    workDir: string;
    projectPaths: Awaited<ReturnType<typeof prepareBatchProjectPaths>>['projectPaths'];
    sourceSegments: SrtSegment[];
    translatedSegments: SrtSegment[];
}

async function prepareQueueItem(
    item: BatchQueueItem,
    options: BatchQueueOptions,
    onStageChange: (stage: string) => void,
    onItemPatch: (patch: Partial<BatchQueueItem>) => void
): Promise<PreparedBatchQueueItem> {
    const applyStage = (stageKey: BatchQueueStageKey, stage: string) => {
        onItemPatch(createStage(stageKey, stage));
        onStageChange(stage);
    };

    applyStage(BATCH_QUEUE_STAGE.preparingOutput, '准备输出目录');
    const { projectPaths } = await prepareBatchProjectPaths(
        item.fileName,
        item.id,
        resolveItemOutputDir(item, options.outputDirOverride)
    );
    const outputPath = projectPaths.finalVideoPath;
    const workDir = projectPaths.sessionTempDir;
    onItemPatch({
        resolvedOutputDir: projectPaths.outputDir
    });

    try {
        let sourceSegments: SrtSegment[];
        let sourceSubtitleContent = item.originalSubtitleContent;
        if (sourceSubtitleContent) {
            sourceSegments = resolveSourceSegments(item);
        } else {
            applyStage(BATCH_QUEUE_STAGE.sourceSubtitleGenerating, '识别原字幕');
            const subtitleResult = await generateSubtitleForItem(item, {
                outputDirOverride: options.outputDirOverride,
                asrService: options.asrService,
                asrOriLang: options.asrOriLang,
                setStatus: options.setStatus
            });
            sourceSubtitleContent = subtitleResult.subtitleContent;
            sourceSegments = parseSRTContent(subtitleResult.subtitleContent);
            onItemPatch({
                originalSubtitlePath: subtitleResult.subtitlePath,
                originalSubtitleContent: subtitleResult.subtitleContent
            });
        }

        if (sourceSegments.length === 0) {
            throw new Error('字幕解析失败，未找到有效片段');
        }

        applyStage(BATCH_QUEUE_STAGE.savingSourceSubtitles, '保存原字幕');
        await saveSubtitleArtifacts(projectPaths.finalDir, item.fileName, sourceSegments, sourceSegments);
        onItemPatch({
            originalSubtitlePath: projectPaths.originalSubtitlePath,
            originalSubtitleContent: sourceSubtitleContent || segmentsToSRT(sourceSegments)
        });

        let translatedSegments: SrtSegment[];
        if (item.translatedSubtitleContent) {
            applyStage(BATCH_QUEUE_STAGE.loadingTranslatedSubtitles, '加载翻译字幕');
            translatedSegments = parseSRTContent(item.translatedSubtitleContent);
        } else {
            applyStage(BATCH_QUEUE_STAGE.translatingSubtitles, '翻译字幕');
            translatedSegments = await translateSegments(sourceSegments, options);
        }

        if (translatedSegments.length === 0) {
            throw new Error('翻译字幕为空，无法生成配音');
        }

        await saveSubtitleArtifacts(projectPaths.finalDir, item.fileName, sourceSegments, translatedSegments);
        onItemPatch({
            translatedSubtitlePath: projectPaths.translatedSubtitlePath,
            translatedSubtitleContent: item.translatedSubtitleContent || segmentsToSRT(translatedSegments)
        });

        return {
            outputPath,
            workDir,
            projectPaths,
            sourceSegments,
            translatedSegments
        };
    } finally {
        // Keep session cache so interrupted batch tasks can resume from saved subtitles/audio fragments.
    }
}

async function finalizeQueueItem(
    item: BatchQueueItem,
    prepared: PreparedBatchQueueItem,
    options: BatchQueueOptions,
    onStageChange: (stage: string) => void
) {
    const applyStage = (_stageKey: BatchQueueStageKey, stage: string) => {
        onStageChange(stage);
    };

    const { outputPath, workDir, projectPaths, sourceSegments, translatedSegments } = prepared;

    applyStage(BATCH_QUEUE_STAGE.generatingDubbing, '生成配音');
    const mergedSegments = translatedSegments.map(segment => ({ ...segment }));
    const recoveredCount = await recoverExistingBatchAudioSegments(mergedSegments, workDir);
    const pendingSegments = mergedSegments
        .map((segment, index) => ({
            ...segment,
            original_index: index,
            source_text: sourceSegments[index]?.text || ''
        }))
        .filter((segment) => !(segment as SrtSegment & { path?: string }).path);

    if (recoveredCount > 0) {
        applyStage(
            BATCH_QUEUE_STAGE.generatingDubbing,
            pendingSegments.length > 0
                ? `继续生成剩余配音（已复用 ${recoveredCount} 条）`
                : `已复用全部 ${recoveredCount} 条配音`
        );
    }

    const failedIndexes: number[] = [];
    if (pendingSegments.length > 0) {
        const tempJsonPath = `${workDir}\\segments.json`;
        await window.api.saveFile(tempJsonPath, JSON.stringify(pendingSegments, null, 2));
        const ttsResult = await window.api.runBackend(
            buildBatchTtsArgs(
                item.sourcePath,
                projectPaths.sessionAudioDir,
                tempJsonPath,
                options,
                recoveredCount,
                mergedSegments.length
            )
        );
        if (!ttsResult || !ttsResult.success) {
            throw new Error(ttsResult?.error || '批量配音失败');
        }

        for (const result of ttsResult.results || []) {
            const idx = result.index;
            if (typeof idx !== 'number' || !mergedSegments[idx]) continue;
            if (result.success && result.audio_path) {
                (mergedSegments[idx] as SrtSegment & { path?: string }).path = result.audio_path;
            } else {
                failedIndexes.push(idx);
            }
        }

        await cleanupOutputArtifacts(projectPaths.finalDir, [tempJsonPath]);
    }

    if (failedIndexes.length > 0) {
        applyStage(BATCH_QUEUE_STAGE.retryingFailedSegments, `重试失败片段 (${failedIndexes.length})`);
        await retryFailedBatchSegments({
            sourcePath: item.sourcePath,
            sessionDir: projectPaths.sessionTempDir,
            sourceSegments,
            translatedSegments: mergedSegments,
            failedIndexes,
            options
        });
    }

    const readySegments = mergedSegments.filter((segment): segment is SrtSegment & { path: string } => Boolean((segment as SrtSegment & { path?: string }).path));
    if (readySegments.length === 0) {
        throw new Error('所有配音片段均失败，无法合成');
    }

    applyStage(
        failedIndexes.length > 0 ? BATCH_QUEUE_STAGE.partialMerge : BATCH_QUEUE_STAGE.mergingVideo,
        failedIndexes.length > 0 ? '部分片段失败，继续合成' : '合成视频'
    );
    const mergeJsonPath = `${workDir}\\merge_segments.json`;
    await window.api.saveFile(mergeJsonPath, JSON.stringify(readySegments, null, 2));
    const mergeResult = await window.api.runBackend([
        '--action', 'merge_video',
        '--input', item.sourcePath,
        '--output', outputPath,
        '--ref', mergeJsonPath,
        '--strategy', options.videoStrategy,
        '--audio_mix_mode', options.audioMixMode,
        '--json'
    ]);

    if (!mergeResult || !mergeResult.success) {
        throw new Error(mergeResult?.error || '合成视频失败');
    }

    await cleanupOutputArtifacts(projectPaths.finalDir, [mergeJsonPath]);
    return mergeResult.output || outputPath;
}

async function recoverExistingBatchAudioSegments(
    segments: Array<SrtSegment & { path?: string }>,
    sessionAudioDir: string
) {
    const recovered = await Promise.all(segments.map(async (segment, index) => {
        const candidatePaths = [
            `${sessionAudioDir}\\segment_${index}.wav`,
            `${sessionAudioDir}\\segment_retry_${index}.wav`
        ];

        let resolvedPath: string | undefined;
        for (const candidatePath of candidatePaths) {
            const exists = await window.api.checkFileExists(candidatePath);
            if (exists) {
                resolvedPath = candidatePath;
                break;
            }
        }

        if (!resolvedPath) {
            return false;
        }
        segment.path = resolvedPath;
        return true;
    }));

    return recovered.filter(Boolean).length;
}

async function prepareFallbackReferenceAudio(
    sourcePath: string,
    workDir: string,
    segments: SrtSegment[]
) {
    if (segments.length === 0) {
        return undefined;
    }

    const refJsonPath = `${workDir}\\fallback_ref_segments.json`;
    await window.api.saveFile(refJsonPath, JSON.stringify(segments, null, 2));
    try {
        const result = await window.api.runBackend([
            '--action', 'prepare_reference_audio',
            '--input', sourcePath,
            '--ref', refJsonPath,
            '--output', workDir,
            '--json'
        ], { lane: 'prep' });
        if (result?.success && result.ref_audio_path) {
            return {
                audioPath: result.ref_audio_path as string,
                refText: result.meta?.text || ''
            };
        }
        return undefined;
    } finally {
        await window.api.deletePath(refJsonPath);
    }
}

async function retryFailedBatchSegments({
    sourcePath,
    sessionDir,
    sourceSegments,
    translatedSegments,
    failedIndexes,
    options,
    fallbackReferenceAudio
}: {
    sourcePath: string;
    sessionDir: string;
    sourceSegments: SrtSegment[];
    translatedSegments: Array<SrtSegment & { path?: string }>;
    failedIndexes: number[];
    options: BatchQueueOptions;
    fallbackReferenceAudio?: {
        audioPath: string;
        refText: string;
    };
}) {
    const fallbackRefAudio = fallbackReferenceAudio || await prepareFallbackReferenceAudio(sourcePath, sessionDir, translatedSegments);

    for (const index of failedIndexes) {
        const segment = translatedSegments[index];
        if (!segment) continue;

        const outputPath = `${sessionDir}\\segment_${index}.wav`;
        const result = await window.api.runBackend(
            buildSingleTtsArgs(
                sourcePath,
                outputPath,
                segment,
                options,
                fallbackRefAudio?.audioPath,
                collectNearbySuccessfulAudioPaths(translatedSegments, index),
                sourceSegments[index]?.text || '',
                fallbackRefAudio?.refText
            )
        );
        if (result && result.success && result.audio_path) {
            segment.path = result.audio_path;
        }
    }
}

function resolveSourceSegments(item: BatchQueueItem): SrtSegment[] {
    if (item.originalSubtitleContent) {
        return parseSRTContent(item.originalSubtitleContent);
    }
    if (item.translatedSubtitleContent) {
        return parseSRTContent(item.translatedSubtitleContent);
    }
    return [];
}

async function translateSegments(
    segments: SrtSegment[],
    options: Pick<BatchQueueOptions, 'targetLang'> | BatchSubtitleTranslationOptions
) {
    const args = [
        '--action', 'translate_text',
        '--input', JSON.stringify(segments),
        '--lang', options.targetLang,
        '--json'
    ];

    appendStoredTranslationArgs(args);

    const result = await window.api.runBackend(args, { lane: 'prep' });
    if (!result || !result.success || !Array.isArray(result.segments)) {
        throw new Error(result?.error || '字幕翻译失败');
    }
    return result.segments as SrtSegment[];
}

function buildBatchTtsArgs(
    sourcePath: string,
    outputDir: string,
    refJsonPath: string,
    options: BatchQueueOptions,
    resumeCompleted = 0,
    resumeTotal = 0
) {
    const args = [
        '--action', 'generate_batch_tts',
        '--input', sourcePath,
        '--output', outputDir,
        '--ref', refJsonPath,
        '--tts_service', options.ttsService,
        '--strategy', options.videoStrategy,
        '--audio_mix_mode', options.audioMixMode,
        '--batch_size', String(options.ttsService === 'qwen' ? options.cloneBatchSize : options.batchSize),
        '--max_new_tokens', String(options.maxNewTokens),
        '--dub_retry_attempts', '3',
        '--resume_completed', String(Math.max(0, resumeCompleted)),
        '--resume_total', String(Math.max(0, resumeTotal)),
        '--lang', options.targetLang,
        '--json'
    ];

    appendTtsArgs(args, options);
    return args;
}

function buildSingleTtsArgs(
    sourcePath: string,
    outputPath: string,
    segment: SrtSegment,
    options: BatchQueueOptions,
    fallbackRefAudio?: string,
    nearbyRefAudios?: Array<{ audio_path: string; ref_text?: string }>,
    qwenRefText?: string,
    fallbackRefText?: string
) {
    const args = [
        '--action', 'generate_single_tts',
        '--input', sourcePath,
        '--output', outputPath,
        '--text', segment.text,
        '--start', String(segment.start),
        '--duration', String(Math.max(segment.end - segment.start, 0.1)),
        '--lang', options.targetLang,
        '--tts_service', options.ttsService,
        '--strategy', options.videoStrategy,
        '--max_new_tokens', String(options.maxNewTokens),
        '--dub_retry_attempts', '3',
        '--json'
    ];

    if (fallbackRefAudio) {
        args.push('--fallback_ref_audio', fallbackRefAudio);
    }

    if (fallbackRefText) {
        args.push('--fallback_ref_text', fallbackRefText);
    }

    if (nearbyRefAudios && nearbyRefAudios.length > 0) {
        args.push('--nearby_ref_audios', JSON.stringify(nearbyRefAudios));
    }

    if (qwenRefText) {
        args.push('--qwen_ref_text', qwenRefText);
    }

    appendTtsArgs(args, options);
    return args;
}

function collectNearbySuccessfulAudioPaths(
    segments: Array<SrtSegment & { path?: string }>,
    index: number,
    maxRefs = 2
) {
    const refs: Array<{ audio_path: string; ref_text?: string }> = [];
    const seen = new Set<string>();

    const candidates = segments
        .map((segment, candidateIndex) => ({
            candidateIndex,
            distance: Math.abs(candidateIndex - index),
            path: segment.path,
            refText: segment.text
        }))
        .filter(candidate => candidate.candidateIndex !== index && Boolean(candidate.path))
        .sort((a, b) => a.distance - b.distance);

    for (const candidate of candidates) {
        if (!candidate.path || seen.has(candidate.path)) continue;
        seen.add(candidate.path);
        refs.push({
            audio_path: candidate.path,
            ref_text: candidate.refText || ''
        });
        if (refs.length >= maxRefs) break;
    }

    return refs;
}

function appendTtsArgs(args: string[], options: BatchQueueOptions) {
    if (options.ttsService === 'qwen') {
        const qwenSettings = getStoredQwenTtsSettings();
        args.push('--qwen_mode', qwenSettings.mode);
        args.push('--qwen_model_size', qwenSettings.modelSize);

        if (qwenSettings.mode === 'preset') {
            args.push('--preset_voice', qwenSettings.presetVoice);
        } else if (qwenSettings.mode === 'design') {
            args.push('--voice_instruct', qwenSettings.voiceInstruction);
            if (qwenSettings.designRefAudio) args.push('--ref_audio', qwenSettings.designRefAudio);
        } else {
            if (qwenSettings.refAudio) args.push('--ref_audio', qwenSettings.refAudio);
            if (qwenSettings.refText) args.push('--qwen_ref_text', qwenSettings.refText);
        }
    } else {
        const refAudio = localStorage.getItem('tts_ref_audio_path');
        if (refAudio) args.push('--ref_audio', refAudio);
    }
}
