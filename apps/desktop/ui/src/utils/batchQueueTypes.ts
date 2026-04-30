import type { SrtSegment } from './srt';
import type { prepareBatchProjectPaths } from './projectPaths';
import type { SessionManifest, SessionResumePlan } from './sessionManifest';
import type { QueueResumeInfo, StructuredErrorInfo } from '../types/workflow';

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
    errorInfo?: StructuredErrorInfo;
    resumeInfo?: QueueResumeInfo;
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

export type BatchQueueStageKey = typeof BATCH_QUEUE_STAGE[keyof typeof BATCH_QUEUE_STAGE];

export function createStage(stageKey: BatchQueueStageKey, stage: string) {
    return { stageKey, stage };
}

export interface BatchQueueOptions {
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

export interface BatchSubtitleGenerationOptions {
    outputDirOverride?: string;
    targetLang: string;
    asrService: string;
    asrOriLang: string;
    setStatus: (value: string) => void;
}

export interface BatchSubtitleTranslationOptions {
    outputDirOverride?: string;
    targetLang: string;
    asrOriLang: string;
    setStatus: (value: string) => void;
}

export interface PreparedBatchQueueItem {
    outputPath: string;
    workDir: string;
    projectPaths: Awaited<ReturnType<typeof prepareBatchProjectPaths>>['projectPaths'];
    sourceSegments: SrtSegment[];
    translatedSegments: SrtSegment[];
    sessionManifest?: SessionManifest | null;
    resumePlan?: SessionResumePlan;
}

export interface BatchOperationSummary {
    successCount: number;
    failedCount: number;
    skippedCount: number;
}

export function resolveItemOutputDir(item: Pick<BatchQueueItem, 'resolvedOutputDir'>, outputDirOverride?: string) {
    return item.resolvedOutputDir?.trim() || outputDirOverride;
}

export function pickNextPendingQueueItem(items: BatchQueueItem[]) {
    return items.find(item => (
        item.status === 'pending' && item.stageKey === BATCH_QUEUE_STAGE.retryWaiting
    )) || items.find(item => item.status === 'pending');
}
