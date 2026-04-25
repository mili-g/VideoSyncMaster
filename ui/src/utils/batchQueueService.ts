import { parseSRTContent, segmentsToSRT, type SrtSegment } from './srt';
import { cleanupOutputArtifacts, saveSubtitleArtifacts } from './outputArtifacts';
import { prepareBatchProjectPaths } from './projectPaths';
import { appendStoredTranslationArgs, getStoredTtsVoiceMode, getStoredWhisperVadSettings } from './runtimeSettings';
import { cleanupSessionArtifacts } from './sessionCleanup';
import { getSessionResumePlan, initializeSessionManifest, readSessionManifest, updateSessionManifest } from './sessionManifest';
import { normalizeBackendError } from './backendErrors';
import { buildBatchTtsArgs, buildSingleTtsArgs, collectNearbySuccessfulAudioRefs, prepareFallbackReferenceAudio as prepareFallbackReferenceAudioForDubbing, recoverExistingAudioSegments } from './dubbingWorkflowService';
import { logUiError } from './frontendLogger';
import { markQueueItemStopped, markQueueItemProcessing } from './batchQueueTransitions';
import {
    BATCH_QUEUE_STAGE,
    createStage,
    resolveItemOutputDir,
    type BatchOperationSummary,
    type BatchQueueItem,
    type BatchQueueOptions,
    type BatchQueueStageKey,
    type BatchSubtitleGenerationOptions,
    type BatchSubtitleTranslationOptions,
    type PreparedBatchQueueItem
} from './batchQueueTypes';
import type { QueueResumeInfo } from '../types/workflow';

export async function generateSubtitleForItem(
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

    if (options.asrOriLang && options.asrOriLang !== 'Auto' && options.asrOriLang !== 'None') {
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

export async function prepareQueueItem(
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
    const existingManifest = await readSessionManifest(projectPaths);
    const resumePlan = await getSessionResumePlan(existingManifest, projectPaths);
    onItemPatch({
        resolvedOutputDir: projectPaths.outputDir,
        resumeInfo: resumePlanToQueueResumeInfo(existingManifest, resumePlan)
    });
    if (existingManifest) {
        await updateSessionManifest(projectPaths, {
            sessionKey: projectPaths.sessionKey,
            fileName: item.fileName,
            sourcePath: item.sourcePath,
            phase: 'preparing',
            currentStage: resumePlan.isRecoverable
                ? `恢复准备 - ${existingManifest.currentStage || '继续处理中'}`
                : '准备输出目录',
            outputDir: projectPaths.outputDir,
            artifacts: {
                sessionCacheDir: projectPaths.sessionCacheDir,
                sessionAudioDir: projectPaths.sessionAudioDir,
                sessionTempDir: projectPaths.sessionTempDir,
                finalDir: projectPaths.finalDir,
                finalVideoPath: projectPaths.finalVideoPath,
                originalSubtitlePath: projectPaths.originalSubtitlePath,
                translatedSubtitlePath: projectPaths.translatedSubtitlePath
            }
        });
    } else {
        await initializeSessionManifest(projectPaths, {
            sessionKey: projectPaths.sessionKey,
            fileName: item.fileName,
            sourcePath: item.sourcePath,
            phase: 'preparing',
            currentStage: '准备输出目录',
            outputDir: projectPaths.outputDir,
            artifacts: {
                sessionCacheDir: projectPaths.sessionCacheDir,
                sessionAudioDir: projectPaths.sessionAudioDir,
                sessionTempDir: projectPaths.sessionTempDir,
                finalDir: projectPaths.finalDir,
                finalVideoPath: projectPaths.finalVideoPath,
                originalSubtitlePath: projectPaths.originalSubtitlePath,
                translatedSubtitlePath: projectPaths.translatedSubtitlePath
            },
            resume: {
                recoverable: false,
                preservedAudioSegments: []
            }
        });
    }

    try {
        let sourceSegments: SrtSegment[] = [];
        let sourceSubtitleContent = item.originalSubtitleContent;
        let restoredSourceFromManifest = false;
        if (!sourceSubtitleContent && resumePlan.canReuseSourceSubtitles && resumePlan.sourceSubtitlePath) {
            applyStage(BATCH_QUEUE_STAGE.sourceSubtitleGenerating, '恢复原字幕');
            sourceSubtitleContent = await readSubtitleContent(resumePlan.sourceSubtitlePath);
            restoredSourceFromManifest = true;
            onItemPatch({
                originalSubtitlePath: resumePlan.sourceSubtitlePath,
                originalSubtitleContent: sourceSubtitleContent
            });
        }

        if (sourceSubtitleContent) {
            sourceSegments = resolveSourceSegments(item);
            if (sourceSegments.length === 0 && sourceSubtitleContent) {
                sourceSegments = parseSRTContent(sourceSubtitleContent);
            }
            if (sourceSegments.length === 0 && restoredSourceFromManifest) {
                sourceSubtitleContent = undefined;
            }
        }

        if (!sourceSubtitleContent) {
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
            await updateSessionManifest(projectPaths, {
                phase: 'source_subtitles_ready',
                currentStage: '原字幕已准备',
                resume: {
                    recoverable: false
                },
                lastError: null
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
        await updateSessionManifest(projectPaths, {
            phase: 'source_subtitles_ready',
            currentStage: '原字幕已保存',
            lastError: null
        });

        let translatedSegments: SrtSegment[] = [];
        let translatedSubtitleContent = item.translatedSubtitleContent;
        let restoredTranslationFromManifest = false;
        if (!translatedSubtitleContent && resumePlan.canReuseTranslatedSubtitles && resumePlan.translatedSubtitlePath) {
            applyStage(BATCH_QUEUE_STAGE.loadingTranslatedSubtitles, '恢复翻译字幕');
            translatedSubtitleContent = await readSubtitleContent(resumePlan.translatedSubtitlePath);
            restoredTranslationFromManifest = true;
            onItemPatch({
                translatedSubtitlePath: resumePlan.translatedSubtitlePath,
                translatedSubtitleContent
            });
        }

        if (translatedSubtitleContent) {
            applyStage(BATCH_QUEUE_STAGE.loadingTranslatedSubtitles, '加载翻译字幕');
            translatedSegments = parseSRTContent(translatedSubtitleContent);
            if (translatedSegments.length === 0 && restoredTranslationFromManifest) {
                translatedSubtitleContent = undefined;
            }
        }

        if (!translatedSubtitleContent) {
            applyStage(BATCH_QUEUE_STAGE.translatingSubtitles, '翻译字幕');
            translatedSegments = await translateSegments(sourceSegments, options);
            translatedSubtitleContent = segmentsToSRT(translatedSegments);
        }

        if (translatedSegments.length === 0) {
            throw new Error('翻译字幕为空，无法生成配音');
        }

        await saveSubtitleArtifacts(projectPaths.finalDir, item.fileName, sourceSegments, translatedSegments);
        onItemPatch({
            translatedSubtitlePath: projectPaths.translatedSubtitlePath,
            translatedSubtitleContent: translatedSubtitleContent || segmentsToSRT(translatedSegments)
        });
        await updateSessionManifest(projectPaths, {
            phase: 'translated_subtitles_ready',
            currentStage: '翻译字幕已保存',
            lastError: null
        });

        return {
            outputPath,
            workDir,
            projectPaths,
            sourceSegments,
            translatedSegments,
            sessionManifest: existingManifest,
            resumePlan
        };
    } catch (error) {
        await updateSessionManifest(projectPaths, {
            phase: 'failed',
            currentStage: '准备阶段失败',
            resume: {
                recoverable: true
            },
            lastError: {
                code: 'QUEUE_PREPARE_FAILED',
                message: error instanceof Error ? error.message : String(error),
                stage: 'prepare',
                retryable: true
            }
        }).catch((manifestError) => {
            logUiError('准备阶段失败后更新会话清单失败', {
                domain: 'batch.queue',
                action: 'prepareQueueItem',
                detail: manifestError instanceof Error ? manifestError.message : String(manifestError)
            });
        });
        throw error;
    }
}

function resumePlanToQueueResumeInfo(
    manifest: Awaited<ReturnType<typeof readSessionManifest>>,
    resumePlan: Awaited<ReturnType<typeof getSessionResumePlan>>
): QueueResumeInfo {
    return {
        recoverable: resumePlan.isRecoverable,
        canReuseSourceSubtitles: resumePlan.canReuseSourceSubtitles,
        canReuseTranslatedSubtitles: resumePlan.canReuseTranslatedSubtitles,
        canResumeDubbing: resumePlan.canResumeDubbing,
        canResumeMerge: resumePlan.canResumeMerge,
        preservedAudioSegments: resumePlan.preservedAudioSegments.length,
        blockedReason: resumePlan.blockedReason,
        lastMode: manifest?.resume.lastMode
    };
}

export function buildQueueItemErrorInfo(errorOrResult: unknown, fallbackMessage: string) {
    return normalizeBackendError(errorOrResult, fallbackMessage);
}

export async function finalizeQueueItem(
    item: BatchQueueItem,
    prepared: PreparedBatchQueueItem,
    options: BatchQueueOptions,
    onStageChange: (stage: string) => void
) {
    const applyStage = (_stageKey: BatchQueueStageKey, stage: string) => {
        onStageChange(stage);
    };

    const { outputPath, workDir, projectPaths, sourceSegments, translatedSegments, resumePlan } = prepared;
    try {
        await updateSessionManifest(projectPaths, {
            phase: 'dubbing',
            currentStage: '开始生成配音',
            lastError: null
        });

        applyStage(BATCH_QUEUE_STAGE.generatingDubbing, '生成配音');
        const mergedSegments = translatedSegments.map(segment => ({ ...segment }));
        const recoveredCount = await recoverExistingBatchAudioSegments(
            mergedSegments,
            projectPaths.sessionAudioDir,
            resumePlan?.preservedAudioSegments
        );
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
            await updateSessionManifest(projectPaths, {
                currentStage: pendingSegments.length > 0
                    ? `继续生成剩余配音（已复用 ${recoveredCount} 条）`
                    : `已复用全部 ${recoveredCount} 条配音`,
                resume: {
                    recoverable: true
                }
            });
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
                throw ttsResult || new Error('批量配音失败');
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
            await updateSessionManifest(projectPaths, {
                currentStage: `重试失败片段 (${failedIndexes.length})`,
                resume: {
                    recoverable: true
                }
            });
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
        await updateSessionManifest(projectPaths, {
            phase: 'merging',
            currentStage: failedIndexes.length > 0 ? '部分片段失败，继续合成' : '合成视频',
            resume: {
                recoverable: true
            }
        });
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
            throw mergeResult || new Error('合成视频失败');
        }

        await updateSessionManifest(projectPaths, {
            phase: 'completed',
            currentStage: '视频合成完成',
            resume: {
                recoverable: false
            },
            lastError: null
        });
        await cleanupSessionArtifacts(projectPaths, 'success', [mergeJsonPath]);
        return mergeResult.output || outputPath;
    } catch (error) {
        await updateSessionManifest(projectPaths, {
            phase: 'failed',
            currentStage: '合成阶段失败',
            resume: {
                recoverable: true
            },
            lastError: {
                code: 'QUEUE_FINALIZE_FAILED',
                message: error instanceof Error ? error.message : String(error),
                stage: 'finalize',
                retryable: true
            }
        }).catch((manifestError) => {
            logUiError('合成阶段失败后更新会话清单失败', {
                domain: 'batch.queue',
                action: 'finalizeQueueItem',
                detail: manifestError instanceof Error ? manifestError.message : String(manifestError)
            });
        });
        throw error;
    }
}

export function resolveSourceSegments(item: BatchQueueItem): SrtSegment[] {
    if (item.originalSubtitleContent) {
        return parseSRTContent(item.originalSubtitleContent);
    }
    if (item.translatedSubtitleContent) {
        return parseSRTContent(item.translatedSubtitleContent);
    }
    return [];
}

export async function translateSegments(
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
        throw result || new Error('字幕翻译失败');
    }
    return result.segments as SrtSegment[];
}

export async function runBatchSubtitleGenerationQueue({
    queue,
    options,
    isStopped,
    isCanceledError,
    onActivateItem,
    onItemUpdate
}: {
    queue: BatchQueueItem[];
    options: BatchSubtitleGenerationOptions;
    isStopped: () => boolean;
    isCanceledError: (error: unknown) => boolean;
    onActivateItem: (itemId: string | null) => void;
    onItemUpdate: (itemId: string, updater: (current: BatchQueueItem) => BatchQueueItem) => void;
}): Promise<BatchOperationSummary> {
    let successCount = 0;
    let failedCount = 0;

    for (const item of queue) {
        if (isStopped()) {
            break;
        }

        const itemStartedAt = Date.now();
        onActivateItem(item.id);
        onItemUpdate(item.id, current => ({
            ...markQueueItemProcessing(current, BATCH_QUEUE_STAGE.sourceSubtitleGenerating, '正在识别原字幕'),
            startedAt: itemStartedAt
        }));

        try {
            const { outputDir, subtitlePath, subtitleContent } = await generateSubtitleForItem(item, options);
            if (isStopped()) {
                onItemUpdate(item.id, current => markQueueItemStopped(current, '队列已停止，可继续识别或开始批量处理'));
                continue;
            }
            successCount += 1;

            onItemUpdate(item.id, current => ({
                ...current,
                status: 'pending',
                ...createStage(
                    item.originalSubtitleContent ? BATCH_QUEUE_STAGE.sourceSubtitleRefreshed : BATCH_QUEUE_STAGE.sourceSubtitleReady,
                    item.originalSubtitleContent ? '原字幕已刷新，可继续批量处理' : '原字幕已生成，可继续批量处理'
                ),
                resolvedOutputDir: outputDir,
                originalSubtitlePath: subtitlePath,
                originalSubtitleContent: subtitleContent,
                errorInfo: undefined,
                finishedAt: Date.now(),
                elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
            }));
        } catch (error: any) {
            if (isStopped() || isCanceledError(error)) {
                onItemUpdate(item.id, current => markQueueItemStopped(current, '队列已停止，可继续识别或开始批量处理'));
                continue;
            }
            failedCount += 1;
            onItemUpdate(item.id, current => ({
                ...current,
                status: 'pending',
                ...createStage(BATCH_QUEUE_STAGE.sourceSubtitleFailed, '字幕识别失败，可稍后重试或直接继续完整流程'),
                errorInfo: buildQueueItemErrorInfo(error, '字幕识别失败'),
                finishedAt: Date.now(),
                elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
            }));
        }
    }

    onActivateItem(null);
    return {
        successCount,
        failedCount,
        skippedCount: Math.max(0, queue.length - successCount - failedCount)
    };
}

export async function runBatchSubtitleTranslationQueue({
    queue,
    options,
    isStopped,
    isCanceledError,
    onActivateItem,
    onItemUpdate
}: {
    queue: BatchQueueItem[];
    options: BatchSubtitleTranslationOptions;
    isStopped: () => boolean;
    isCanceledError: (error: unknown) => boolean;
    onActivateItem: (itemId: string | null) => void;
    onItemUpdate: (itemId: string, updater: (current: BatchQueueItem) => BatchQueueItem) => void;
}): Promise<BatchOperationSummary> {
    let successCount = 0;
    let failedCount = 0;

    for (const item of queue) {
        if (isStopped()) {
            break;
        }

        const itemStartedAt = Date.now();
        onActivateItem(item.id);
        onItemUpdate(item.id, current => ({
            ...markQueueItemProcessing(current, BATCH_QUEUE_STAGE.translatingSubtitles, '正在翻译字幕'),
            startedAt: itemStartedAt
        }));

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

            if (isStopped()) {
                onItemUpdate(item.id, current => markQueueItemStopped(current, '队列已停止，可继续翻译或开始批量处理'));
                continue;
            }

            successCount += 1;
            onItemUpdate(item.id, current => ({
                ...current,
                status: 'pending',
                ...createStage(
                    item.translatedSubtitleContent ? BATCH_QUEUE_STAGE.translatedSubtitleRefreshed : BATCH_QUEUE_STAGE.translatedSubtitleReady,
                    item.translatedSubtitleContent ? '翻译字幕已刷新，可继续批量处理' : '翻译字幕已生成，可继续批量处理'
                ),
                resolvedOutputDir: projectPaths.outputDir,
                translatedSubtitlePath: projectPaths.translatedSubtitlePath,
                translatedSubtitleContent,
                errorInfo: undefined,
                finishedAt: Date.now(),
                elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
            }));
        } catch (error: any) {
            if (isStopped() || isCanceledError(error)) {
                onItemUpdate(item.id, current => markQueueItemStopped(current, '队列已停止，可继续翻译或开始批量处理'));
                continue;
            }

            failedCount += 1;
            onItemUpdate(item.id, current => ({
                ...current,
                status: 'pending',
                ...createStage(BATCH_QUEUE_STAGE.translatedSubtitleFailed, '字幕翻译失败，可稍后重试或继续完整流程'),
                errorInfo: buildQueueItemErrorInfo(error, '字幕翻译失败'),
                finishedAt: Date.now(),
                elapsedMs: current.startedAt ? Math.max(0, Date.now() - current.startedAt) : current.elapsedMs
            }));
        }
    }

    onActivateItem(null);
    return {
        successCount,
        failedCount,
        skippedCount: Math.max(0, queue.length - successCount - failedCount)
    };
}

async function recoverExistingBatchAudioSegments(
    segments: Array<SrtSegment & { path?: string }>,
    sessionAudioDir: string,
    preferredPaths: string[] = []
) {
    return recoverExistingAudioSegments(segments, sessionAudioDir, preferredPaths, 'path');
}

async function readSubtitleContent(subtitlePath: string) {
    const raw = await window.api.readFile(subtitlePath);
    if (!raw?.trim()) {
        throw new Error(`字幕文件为空或无法读取: ${subtitlePath}`);
    }
    return raw;
}

async function prepareFallbackReferenceAudio(
    sourcePath: string,
    workDir: string,
    segments: SrtSegment[]
) {
    return prepareFallbackReferenceAudioForDubbing(sourcePath, workDir, segments, 'prep');
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
    const voiceMode = getStoredTtsVoiceMode();
    const useNarrationMode = voiceMode === 'narration';
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
                {
                    ...options,
                    fallbackRefAudio: fallbackRefAudio?.audioPath,
                    fallbackRefText: fallbackRefAudio?.refText,
                    nearbyRefAudios: useNarrationMode ? [] : collectNearbySuccessfulAudioRefs(translatedSegments, index),
                    qwenRefText: useNarrationMode ? '' : (sourceSegments[index]?.text || '')
                }
            )
        );
        if (result && result.success && result.audio_path) {
            segment.path = result.audio_path;
        }
    }
}
