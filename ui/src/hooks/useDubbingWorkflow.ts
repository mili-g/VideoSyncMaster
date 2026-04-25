import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { AudioMixMode, Segment } from './useVideoProject';
import { saveSubtitleArtifacts } from '../utils/outputArtifacts';
import { prepareSingleProjectPaths } from '../utils/projectPaths';
import { isBackendCanceledError } from '../utils/backendCancellation';
import { buildUserFacingErrorMessage, normalizeBackendError } from '../utils/backendErrors';
import { getStoredTtsVoiceMode } from '../utils/runtimeSettings';
import { cleanupSessionArtifacts } from '../utils/sessionCleanup';
import { getSessionResumePlan, initializeSessionManifest, readSessionManifest, updateSessionManifest } from '../utils/sessionManifest';
import { buildBatchTtsArgs, buildSingleTtsArgs, buildTtsExtraArgs, collectNearbySuccessfulAudioRefs, prepareFallbackReferenceAudio, recoverExistingAudioSegments } from '../utils/dubbingWorkflowService';
import { logUiError } from '../utils/frontendLogger';
import type { SessionManifest } from '../utils/sessionManifest';

type FeedbackType = 'success' | 'error';

interface FeedbackPayload {
    title: string;
    message: string;
    type: FeedbackType;
}

interface DubbingWorkflowOptions {
    originalVideoPath: string;
    sourceSegments: Segment[];
    translatedSegments: Segment[];
    outputDirOverride?: string;
    targetLang: string;
    ttsService: 'indextts' | 'qwen';
    batchSize: number;
    cloneBatchSize: number;
    maxNewTokens: number;
    videoStrategy: string;
    audioMixMode: AudioMixMode;
    abortRef: MutableRefObject<boolean>;
    setTranslatedSegments: Dispatch<SetStateAction<Segment[]>>;
    setGeneratingSegmentId: Dispatch<SetStateAction<number | null>>;
    setDubbingLoading: Dispatch<SetStateAction<boolean>>;
    setLoading: Dispatch<SetStateAction<boolean>>;
    setIsIndeterminate: Dispatch<SetStateAction<boolean>>;
    setProgress: Dispatch<SetStateAction<number>>;
    setStatus: Dispatch<SetStateAction<string>>;
    setFeedback: Dispatch<SetStateAction<FeedbackPayload | null>>;
    setMergedVideoPath: Dispatch<SetStateAction<string>>;
}

export function useDubbingWorkflow({
    originalVideoPath,
    sourceSegments,
    translatedSegments,
    outputDirOverride,
    targetLang,
    ttsService,
    batchSize,
    cloneBatchSize,
    maxNewTokens,
    videoStrategy,
    audioMixMode,
    abortRef,
    setTranslatedSegments,
    setGeneratingSegmentId,
    setDubbingLoading,
    setLoading,
    setIsIndeterminate,
    setProgress,
    setStatus,
    setFeedback,
    setMergedVideoPath
}: DubbingWorkflowOptions) {
    const hasErrors = translatedSegments.some(segment => segment.audioStatus === 'error');
    const voiceMode = getStoredTtsVoiceMode();
    const useNarrationMode = voiceMode === 'narration';

    const handleGenerateSingleDubbing = async (index: number) => {
        if (!originalVideoPath) return;
        const segment = translatedSegments[index];
        if (!segment) return;

        setTranslatedSegments(prev => {
            const next = [...prev];
            next[index] = { ...next[index], audioStatus: 'pending' };
            return next;
        });
        setGeneratingSegmentId(index);
        setStatus(`正在重新生成片段 ${index + 1} 的配音...`);

        try {
            const { projectPaths } = await prepareSingleProjectPaths(originalVideoPath, outputDirOverride);
            const outputPath = `${projectPaths.sessionAudioDir}\\segment_${index}.wav`;
            await ensureSingleSessionManifest(projectPaths, originalVideoPath, sourceSegments, translatedSegments);

            const fallbackRefAudio = await prepareFallbackReferenceAudio(
                originalVideoPath,
                projectPaths.sessionTempDir,
                sourceSegments.length > 0 ? sourceSegments : translatedSegments
            );

            const result = await window.api.runBackend(
                buildSingleTtsArgs(originalVideoPath, outputPath, segment, {
                    targetLang,
                    ttsService,
                    batchSize,
                    cloneBatchSize,
                    maxNewTokens,
                    videoStrategy,
                    fallbackRefAudio: fallbackRefAudio?.audioPath,
                    fallbackRefText: fallbackRefAudio?.refText,
                    nearbyRefAudios: useNarrationMode ? [] : collectNearbySuccessfulAudioRefs(translatedSegments, index),
                    qwenRefText: useNarrationMode ? '' : (sourceSegments[index]?.text || '')
                })
            );

            const hasPlayableAudio = Boolean(result?.success && result?.audio_path);

            if (hasPlayableAudio) {
                setTranslatedSegments(prev => {
                    const next = [...prev];
                    next[index] = {
                        ...next[index],
                        audioPath: result.audio_path,
                        audioStatus: 'ready',
                        audioDuration: result.duration
                    };
                    return next;
                });
                setStatus(`片段 ${index + 1} 配音生成完成`);
            } else {
                const errorInfo = normalizeBackendError(result, `片段 ${index + 1} 配音生成失败`);
                setTranslatedSegments(prev => {
                    const next = [...prev];
                    next[index] = {
                        ...next[index],
                        audioStatus: 'error',
                        audioPath: result?.audio_path
                    };
                    return next;
                });
                setStatus(buildUserFacingErrorMessage(errorInfo));
            }
        } catch (error) {
            if (isBackendCanceledError(error)) {
                setStatus('任务已由用户停止');
                return;
            }
            logUiError('单段配音生成失败', {
                domain: 'workflow.dubbing',
                action: 'handleGenerateSingleDubbing',
                detail: error instanceof Error ? error.message : String(error)
            });
            const errorInfo = normalizeBackendError(error, `片段 ${index + 1} 配音生成失败`);
            setTranslatedSegments(prev => {
                const next = [...prev];
                next[index] = { ...next[index], audioStatus: 'error' };
                return next;
            });
            setStatus(buildUserFacingErrorMessage(errorInfo));
        } finally {
            setGeneratingSegmentId(null);
        }
    };

    const handleGenerateAllDubbing = async (overrideSegments?: Segment[]): Promise<Segment[] | null> => {
        const segmentsToUse = overrideSegments || translatedSegments;
        if (!originalVideoPath || segmentsToUse.length === 0) return null;

        setDubbingLoading(true);
        abortRef.current = false;
        setStatus('正在批量生成配音...');
        setProgress(0);
        setIsIndeterminate(false);
        let sessionCacheDir: string | null = null;
        let tempJsonPath: string | null = null;

        try {
            const { projectPaths } = await prepareSingleProjectPaths(originalVideoPath, outputDirOverride);
            sessionCacheDir = projectPaths.sessionCacheDir;
            tempJsonPath = `${projectPaths.sessionTempDir}\\segments.json`;
            const resumePlan = await ensureSingleSessionManifest(projectPaths, originalVideoPath, sourceSegments, segmentsToUse);
            await updateSessionManifest(projectPaths, {
                phase: 'dubbing',
                currentStage: '准备生成配音',
                resume: {
                    recoverable: true
                },
                lastError: null
            });

            const workingSegments = segmentsToUse.map(segment => ({ ...segment }));
            const recoveredCount = await recoverExistingAudioSegments(
                workingSegments,
                projectPaths.sessionAudioDir,
                resumePlan?.preservedAudioSegments || [],
                'audioPath'
            );
            const pendingSegments = workingSegments
                .map((segment, index) => ({
                    ...segment,
                    source_text: sourceSegments[index]?.text || ''
                }))
                .filter(segment => !segment.audioPath);

            await window.api.saveFile(tempJsonPath, JSON.stringify(
                pendingSegments
            ));

            const { blocked } = buildTtsExtraArgs(ttsService, batchSize, cloneBatchSize);
            if (blocked) {
                setFeedback(blocked);
                setDubbingLoading(false);
                return null;
            }

            if (recoveredCount > 0) {
                setStatus(pendingSegments.length > 0 ? `继续生成剩余配音（已复用 ${recoveredCount} 条）` : `已复用全部 ${recoveredCount} 条配音`);
            }

            if (pendingSegments.length === 0) {
                setTranslatedSegments(workingSegments);
                setStatus('所有配音片段均已复用');
                return workingSegments;
            }

            const result = await window.api.runBackend(
                buildBatchTtsArgs(
                    originalVideoPath,
                    projectPaths.sessionAudioDir,
                    tempJsonPath,
                    {
                        targetLang,
                        ttsService,
                        batchSize,
                        cloneBatchSize,
                        maxNewTokens,
                        videoStrategy,
                        audioMixMode
                    },
                    recoveredCount,
                    workingSegments.length
                )
            );

            if (abortRef.current) return null;

            if (result && result.success) {
                return new Promise<Segment[]>((resolve) => {
                    setTranslatedSegments(prev => {
                        const next = [...prev];
                        const updatedSegments = workingSegments.map(segment => ({ ...segment }));

                        updatedSegments.forEach((segment, idx) => {
                            if (segment.audioPath) {
                                next[idx] = {
                                    ...next[idx],
                                    audioPath: segment.audioPath,
                                    audioStatus: segment.audioStatus || 'ready'
                                };
                            }
                        });

                        result.results.forEach((resultSegment: any) => {
                            const idx = resultSegment.index !== undefined ? resultSegment.index : resultSegment.original_index;
                            const hasPlayableAudio = Boolean(resultSegment.success && resultSegment.audio_path);
                            if (typeof idx === 'number' && idx >= 0 && idx < next.length) {
                                next[idx] = {
                                    ...next[idx],
                                    audioPath: resultSegment.audio_path,
                                    audioDuration: resultSegment.duration,
                                    audioStatus: hasPlayableAudio ? 'ready' : 'error'
                                };
                            }

                            if (typeof idx === 'number' && idx >= 0 && idx < updatedSegments.length) {
                                updatedSegments[idx] = {
                                    ...updatedSegments[idx],
                                    audioPath: resultSegment.audio_path,
                                    audioDuration: resultSegment.duration,
                                    audioStatus: hasPlayableAudio ? 'ready' : 'error'
                                };
                            }
                        });

                        resolve(updatedSegments);
                        return next;
                    });
                    void updateSessionManifest(projectPaths, {
                        phase: 'dubbing',
                        currentStage: '配音已生成',
                        resume: {
                            recoverable: true
                        },
                        lastError: null
                    });
                    setStatus('批量配音生成完成');
                });
            }

            const errorInfo = normalizeBackendError(result, '批量配音失败');
            setStatus('配音生成失败');
            if (sessionCacheDir) {
                await cleanupSessionArtifacts({ sessionCacheDir }, 'failed', tempJsonPath ? [tempJsonPath] : []);
                tempJsonPath = null;
            }
            setFeedback({
                title: '生成失败',
                message: buildUserFacingErrorMessage(errorInfo),
                type: 'error'
            });
            return null;
        } catch (e: any) {
            if (abortRef.current || isBackendCanceledError(e)) {
                if (sessionCacheDir) {
                    await cleanupSessionArtifacts({ sessionCacheDir }, 'interrupted', tempJsonPath ? [tempJsonPath] : []);
                    tempJsonPath = null;
                }
                setStatus('任务已由用户停止');
                return null;
            }
            logUiError('批量配音执行失败', {
                domain: 'workflow.dubbing',
                action: 'handleGenerateAllDubbing',
                detail: e instanceof Error ? e.message : String(e)
            });
            const errorInfo = normalizeBackendError(e, '批量配音错误');
            if (sessionCacheDir) {
                await cleanupSessionArtifacts({ sessionCacheDir }, 'failed', tempJsonPath ? [tempJsonPath] : []);
                tempJsonPath = null;
            }
            setStatus(buildUserFacingErrorMessage(errorInfo));
            return null;
        } finally {
            if (tempJsonPath) {
                await window.api.deletePath(tempJsonPath);
            }
            if (!abortRef.current) {
                setDubbingLoading(false);
                setProgress(0);
            }
        }
    };

    const handleRetryErrors = async () => {
        const errorSegments = translatedSegments
            .map((segment, index) => ({ segment, index }))
            .filter(item => item.segment.audioStatus === 'error');

        if (errorSegments.length === 0) {
            setStatus('没有找到需要重试的失败片段');
            return;
        }

        setDubbingLoading(true);
        abortRef.current = false;
        setStatus(`正在重试 ${errorSegments.length} 个失败片段...`);

        try {
            const { projectPaths } = await prepareSingleProjectPaths(originalVideoPath, outputDirOverride);

            const fallbackRefAudio = await prepareFallbackReferenceAudio(
                originalVideoPath,
                projectPaths.sessionTempDir,
                sourceSegments.length > 0 ? sourceSegments : translatedSegments
            );

            const totalErrors = errorSegments.length;

            for (let retryIdx = 0; retryIdx < totalErrors; retryIdx += 1) {
                const { segment, index } = errorSegments[retryIdx];
                if (abortRef.current) return;

                setStatus(`正在重试失败配音片段 ${retryIdx + 1}/${totalErrors}...`);
                setTranslatedSegments(prev => {
                    const next = [...prev];
                    next[index] = {
                        ...next[index],
                        audioStatus: 'pending'
                    };
                    return next;
                });

                const outputPath = `${projectPaths.sessionAudioDir}\\segment_retry_${index}.wav`;
                const result = await window.api.runBackend(
                    buildSingleTtsArgs(originalVideoPath, outputPath, segment, {
                        targetLang,
                        ttsService,
                        batchSize,
                        cloneBatchSize,
                        maxNewTokens,
                        videoStrategy,
                        fallbackRefAudio: fallbackRefAudio?.audioPath,
                        fallbackRefText: fallbackRefAudio?.refText,
                        nearbyRefAudios: useNarrationMode ? [] : collectNearbySuccessfulAudioRefs(translatedSegments, index),
                        qwenRefText: useNarrationMode ? '' : (sourceSegments[index]?.text || '')
                    })
                );

                const hasPlayableAudio = Boolean(result?.success && result?.audio_path);

                setTranslatedSegments(prev => {
                    const next = [...prev];
                    next[index] = {
                        ...next[index],
                        audioPath: result?.audio_path,
                        audioDuration: result?.duration,
                        audioStatus: hasPlayableAudio ? 'ready' : 'error'
                    };
                    return next;
                });
                setProgress(Math.round(((retryIdx + 1) / totalErrors) * 100));
            }

            if (!abortRef.current) {
                setStatus('失败片段重试完成');
            }
        } catch (error: any) {
            if (abortRef.current || isBackendCanceledError(error)) {
                setStatus('任务已由用户停止');
                return;
            }
            logUiError('失败片段重试失败', {
                domain: 'workflow.dubbing',
                action: 'handleRetryErrors',
                detail: error instanceof Error ? error.message : String(error)
            });
            const errorInfo = normalizeBackendError(error, '失败片段重试失败');
            setStatus(buildUserFacingErrorMessage(errorInfo));
        } finally {
            if (!abortRef.current) {
                setDubbingLoading(false);
                setProgress(0);
            }
        }
    };

    const handleMergeVideo = async (overrideSegments?: Segment[]) => {
        const segmentsToUse = overrideSegments || translatedSegments;
        if (!originalVideoPath || segmentsToUse.length === 0) return;

        setLoading(true);
        abortRef.current = false;
        setIsIndeterminate(true);
        setStatus('正在合并视频（这可能需要几分钟）...');

        let tempJsonPath: string | null = null;
        let sessionCacheDir: string | null = null;

        try {
            const { fileName, projectPaths } = await prepareSingleProjectPaths(originalVideoPath, outputDirOverride);
            sessionCacheDir = projectPaths.sessionCacheDir;
            await ensureSingleSessionManifest(projectPaths, originalVideoPath, sourceSegments, segmentsToUse);
            const outputVideoPath = projectPaths.finalVideoPath;
            const segmentsForBackend = segmentsToUse
                .map(segment => ({ ...segment, path: segment.audioPath }))
                .filter(segment => segment.path);

            if (segmentsForBackend.length === 0) {
                setStatus('合并失败：未找到有效的配音音频');
                setFeedback({
                    title: '无法合并',
                    message: '没有找到有效的配音音频片段。请确保“步骤 4：语音合成”已经成功完成。',
                    type: 'error'
                });
                return;
            }

            tempJsonPath = `${projectPaths.sessionTempDir}\\merge_segments.json`;
            await window.api.saveFile(tempJsonPath, JSON.stringify(segmentsForBackend));
            await updateSessionManifest(projectPaths, {
                phase: 'merging',
                currentStage: '开始合并视频',
                resume: {
                    recoverable: true
                },
                lastError: null
            });

            const result = await window.api.runBackend([
                '--action', 'merge_video',
                '--input', originalVideoPath,
                '--output', outputVideoPath,
                '--ref', tempJsonPath,
                '--strategy', videoStrategy,
                '--audio_mix_mode', audioMixMode
            ]);

            if (abortRef.current) return;

            if (result && result.success) {
                await saveSubtitleArtifacts(
                    projectPaths.finalDir,
                    fileName,
                    sourceSegments.map(segment => ({ start: segment.start, end: segment.end, text: segment.text })),
                    segmentsToUse.map(segment => ({ start: segment.start, end: segment.end, text: segment.text }))
                );
                await cleanupSessionArtifacts(projectPaths, 'success', [tempJsonPath]);
                tempJsonPath = null;
                setMergedVideoPath(result.output);
                setStatus('视频合并完成');
                setFeedback({
                    title: '处理成功',
                    message: '视频已成功合并并保存到输出文件夹。',
                    type: 'success'
                });
            } else {
                const errorInfo = normalizeBackendError(result, '视频合并失败');
                setStatus('合并失败');
                setFeedback({
                    title: '合并失败',
                    message: buildUserFacingErrorMessage(errorInfo),
                    type: 'error'
                });
                if (sessionCacheDir) {
                    await cleanupSessionArtifacts({ sessionCacheDir }, 'failed', tempJsonPath ? [tempJsonPath] : []);
                    tempJsonPath = null;
                }
            }
        } catch (e: any) {
            if (abortRef.current || isBackendCanceledError(e)) {
                if (sessionCacheDir) {
                    await cleanupSessionArtifacts({ sessionCacheDir }, 'interrupted', tempJsonPath ? [tempJsonPath] : []);
                    tempJsonPath = null;
                }
                setStatus('任务已由用户停止');
                return;
            }
            logUiError('视频合并失败', {
                domain: 'workflow.merge',
                action: 'handleMergeVideo',
                detail: e instanceof Error ? e.message : String(e)
            });
            const errorInfo = normalizeBackendError(e, '视频合并错误');
            if (sessionCacheDir) {
                await cleanupSessionArtifacts({ sessionCacheDir }, 'failed', tempJsonPath ? [tempJsonPath] : []);
                tempJsonPath = null;
            }
            setStatus(buildUserFacingErrorMessage(errorInfo));
        } finally {
            if (tempJsonPath) {
                await window.api.deletePath(tempJsonPath);
            }
            if (!abortRef.current) {
                setLoading(false);
                setIsIndeterminate(false);
            }
        }
    };

    return {
        hasErrors,
        handleRetryErrors,
        handleGenerateSingleDubbing,
        handleGenerateAllDubbing,
        handleMergeVideo
    };
}

async function ensureSingleSessionManifest(
    projectPaths: Awaited<ReturnType<typeof prepareSingleProjectPaths>>['projectPaths'],
    originalVideoPath: string,
    sourceSegments: Segment[],
    translatedSegments: Segment[]
) {
    const existingManifest = await readSessionManifest(projectPaths);
    const resumePlan = await getSessionResumePlan(existingManifest, projectPaths);

    const nextPhase = translatedSegments.length > 0
        ? 'translated_subtitles_ready'
        : sourceSegments.length > 0
            ? 'source_subtitles_ready'
            : 'preparing';
    const currentStage = translatedSegments.length > 0
        ? '翻译字幕已准备'
        : sourceSegments.length > 0
            ? '原字幕已准备'
            : '准备工作流上下文';

    const patch = {
        sessionKey: projectPaths.sessionKey,
        fileName: `${projectPaths.baseName}.mp4`,
        sourcePath: originalVideoPath,
        phase: nextPhase as 'preparing' | 'source_subtitles_ready' | 'translated_subtitles_ready',
        currentStage,
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
            recoverable: resumePlan.isRecoverable
        },
        lastError: null
    };

    if (existingManifest) {
        await updateSessionManifest(projectPaths, patch);
    } else {
        const initialManifest: Omit<SessionManifest, 'version' | 'updatedAt'> = {
            sessionKey: projectPaths.sessionKey,
            fileName: `${projectPaths.baseName}.mp4`,
            sourcePath: originalVideoPath,
            phase: nextPhase,
            currentStage,
            outputDir: projectPaths.outputDir,
            artifacts: patch.artifacts,
            resume: {
                recoverable: false,
                preservedAudioSegments: []
            },
            lastError: undefined
        };
        await initializeSessionManifest(projectPaths, initialManifest);
    }

    return resumePlan;
}
