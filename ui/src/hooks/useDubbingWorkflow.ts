import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { AudioMixMode, Segment } from './useVideoProject';
import { cleanupOutputArtifacts, saveSubtitleArtifacts } from '../utils/outputArtifacts';
import { buildSingleOutputPaths } from '../utils/projectPaths';

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
            const paths = await window.api.getPaths();
            const filenameWithExt = originalVideoPath.split(/[\\/]/).pop() || 'video.mp4';
            const projectPaths = buildSingleOutputPaths(paths, filenameWithExt);
            const outputPath = `${projectPaths.sessionAudioDir}\\segment_${index}.wav`;
            await window.api.ensureDir(projectPaths.sessionAudioDir);
            await window.api.ensureDir(projectPaths.sessionTempDir);

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
                    nearbyRefAudios: collectNearbySuccessfulAudioPaths(translatedSegments, index),
                    qwenRefText: sourceSegments[index]?.text || ''
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
                setTranslatedSegments(prev => {
                    const next = [...prev];
                    next[index] = {
                        ...next[index],
                        audioStatus: 'error',
                        audioPath: result?.audio_path
                    };
                    return next;
                });
                setStatus(`片段 ${index + 1} 配音生成失败`);
            }
        } catch (error) {
            console.error(error);
            setTranslatedSegments(prev => {
                const next = [...prev];
                next[index] = { ...next[index], audioStatus: 'error' };
                return next;
            });
            setStatus(`片段 ${index + 1} 配音生成失败`);
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

        try {
            const paths = await window.api.getPaths();
            const filenameWithExt = originalVideoPath.split(/[\\/]/).pop() || 'video.mp4';
            const projectPaths = buildSingleOutputPaths(paths, filenameWithExt);
            const tempJsonPath = `${projectPaths.sessionTempDir}\\segments.json`;

            await window.api.ensureDir(projectPaths.sessionAudioDir);
            await window.api.ensureDir(projectPaths.sessionTempDir);
            await window.api.saveFile(tempJsonPath, JSON.stringify(
                segmentsToUse.map((segment, index) => ({
                    ...segment,
                    source_text: sourceSegments[index]?.text || ''
                }))
            ));

            const { args: extraArgs, effectiveBatchSize, blocked } = buildTtsExtraArgs(ttsService, batchSize, cloneBatchSize);
            if (blocked) {
                setFeedback(blocked);
                setDubbingLoading(false);
                return null;
            }

            const result = await window.api.runBackend([
                '--action', 'generate_batch_tts',
                '--tts_service', ttsService,
                '--input', originalVideoPath,
                '--output', projectPaths.sessionAudioDir,
                '--ref', tempJsonPath,
                '--batch_size', effectiveBatchSize.toString(),
                '--max_new_tokens', maxNewTokens.toString(),
                '--lang', targetLang,
                '--strategy', videoStrategy,
                '--audio_mix_mode', audioMixMode,
                '--dub_retry_attempts', '3',
                ...extraArgs
            ]);

            if (abortRef.current) return null;

            if (result && result.success) {
                return new Promise<Segment[]>((resolve) => {
                    setTranslatedSegments(prev => {
                        const next = [...prev];
                        const updatedSegments = segmentsToUse.map(segment => ({ ...segment }));

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
                    setStatus('批量配音生成完成');
                });
            }

            setStatus('配音生成失败');
            setFeedback({
                title: '生成失败',
                message: `批量配音失败：\n${result?.error || '未知错误'}`,
                type: 'error'
            });
            return null;
        } catch (e: any) {
            console.error(e);
            setStatus(`配音生成错误: ${e.message}`);
            return null;
        } finally {
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
            const paths = await window.api.getPaths();
            const filenameWithExt = originalVideoPath.split(/[\\/]/).pop() || 'video.mp4';
            const projectPaths = buildSingleOutputPaths(paths, filenameWithExt);
            await window.api.ensureDir(projectPaths.sessionAudioDir);
            await window.api.ensureDir(projectPaths.sessionTempDir);

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
                        nearbyRefAudios: collectNearbySuccessfulAudioPaths(translatedSegments, index),
                        qwenRefText: sourceSegments[index]?.text || ''
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
            console.error(error);
            setStatus(`重试失败: ${error?.message || String(error)}`);
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

        try {
            const paths = await window.api.getPaths();
            const filenameWithExt = originalVideoPath.split(/[\\/]/).pop() || 'video.mp4';
            const projectPaths = buildSingleOutputPaths(paths, filenameWithExt);
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
            await window.api.ensureDir(projectPaths.finalDir);
            await window.api.ensureDir(projectPaths.sessionTempDir);
            await window.api.saveFile(tempJsonPath, JSON.stringify(segmentsForBackend));

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
                    filenameWithExt,
                    sourceSegments.map(segment => ({ start: segment.start, end: segment.end, text: segment.text })),
                    segmentsToUse.map(segment => ({ start: segment.start, end: segment.end, text: segment.text }))
                );
                await cleanupOutputArtifacts(projectPaths.finalDir, [tempJsonPath]);
                tempJsonPath = null;
                setMergedVideoPath(result.output);
                setStatus('视频合并完成');
                setFeedback({
                    title: '处理成功',
                    message: '视频已成功合并并保存到输出文件夹。',
                    type: 'success'
                });
            } else {
                setStatus('合并失败');
                setFeedback({
                    title: '合并失败',
                    message: `视频合并失败：\n${result?.error || '未知错误'}`,
                    type: 'error'
                });
            }
        } catch (e: any) {
            console.error(e);
            setStatus(`合并错误: ${e.message}`);
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

function buildSingleTtsArgs(
    sourcePath: string,
    outputPath: string,
    segment: Segment,
    options: {
        targetLang: string;
        ttsService: 'indextts' | 'qwen';
        batchSize: number;
        cloneBatchSize: number;
        maxNewTokens: number;
        videoStrategy: string;
        fallbackRefAudio?: string;
        fallbackRefText?: string;
        nearbyRefAudios?: Array<{ audio_path: string; ref_text?: string }>;
        qwenRefText?: string;
    }
) {
    const { args: extraArgs } = buildTtsExtraArgs(options.ttsService, options.batchSize, options.cloneBatchSize);
    const args = [
        '--action', 'generate_single_tts',
        '--tts_service', options.ttsService,
        '--input', sourcePath,
        '--output', outputPath,
        '--text', segment.text,
        '--lang', options.targetLang,
        '--start', segment.start.toString(),
        '--duration', String(Math.max(segment.end - segment.start, 0.1)),
        '--strategy', options.videoStrategy,
        '--max_new_tokens', String(options.maxNewTokens),
        '--dub_retry_attempts', '3',
        ...extraArgs,
        '--json'
    ];

    if (options.fallbackRefAudio) {
        args.push('--fallback_ref_audio', options.fallbackRefAudio);
    }

    if (options.fallbackRefText) {
        args.push('--fallback_ref_text', options.fallbackRefText);
    }

    if (options.nearbyRefAudios && options.nearbyRefAudios.length > 0) {
        args.push('--nearby_ref_audios', JSON.stringify(options.nearbyRefAudios));
    }

    if (options.qwenRefText) {
        args.push('--qwen_ref_text', options.qwenRefText);
    }

    return args;
}

function collectNearbySuccessfulAudioPaths(segments: Segment[], index: number, maxRefs = 2) {
    const candidates = segments
        .map((segment, candidateIndex) => ({
            distance: Math.abs(candidateIndex - index),
            path: segment.audioPath,
            candidateIndex,
            status: segment.audioStatus,
            refText: segment.text
        }))
        .filter(candidate =>
            candidate.candidateIndex !== index &&
            candidate.status === 'ready' &&
            Boolean(candidate.path)
        )
        .sort((a, b) => a.distance - b.distance);

    const refs: Array<{ audio_path: string; ref_text?: string }> = [];
    const seen = new Set<string>();
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

async function prepareFallbackReferenceAudio(
    sourcePath: string,
    workDir: string,
    segments: Segment[]
) {
    if (segments.length === 0) {
        return undefined;
    }

    const refJsonPath = `${workDir}\\fallback_ref_segments.json`;
    await window.api.saveFile(refJsonPath, JSON.stringify(
        segments.map(segment => ({
            start: segment.start,
            end: segment.end,
            text: segment.text
        })),
        null,
        2
    ));

    try {
        const result = await window.api.runBackend([
            '--action', 'prepare_reference_audio',
            '--input', sourcePath,
            '--ref', refJsonPath,
            '--output', workDir,
            '--json'
        ]);
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

function buildTtsExtraArgs(
    ttsService: 'indextts' | 'qwen',
    batchSize: number,
    cloneBatchSize: number
) {
    const args: string[] = [];
    let effectiveBatchSize = batchSize;
    let blocked: FeedbackPayload | null = null;

    if (ttsService === 'qwen') {
        const qwenMode = localStorage.getItem('qwen_mode') || 'clone';
        const qwenTtsModel = localStorage.getItem('qwen_tts_model') || '1.7B';

        if (qwenMode === 'design') {
            const designRef = localStorage.getItem('qwen_design_ref_audio');
            if (!designRef) {
                blocked = {
                    title: '需要预览',
                    message: '您还没有完成“声音设计”测试音频。请先在参数设置中点击“合成”，锁定音色效果后再批量生成。',
                    type: 'error'
                };
                return { args, effectiveBatchSize, blocked };
            }
        }

        args.push('--qwen_mode', qwenMode);
        args.push('--qwen_model_size', qwenTtsModel);

        if (qwenMode === 'preset') {
            const preset = localStorage.getItem('qwen_preset_voice') || 'Vivian';
            args.push('--preset_voice', preset);
        } else if (qwenMode === 'design') {
            const instruct = localStorage.getItem('qwen_voice_instruction') || '';
            const designRef = localStorage.getItem('qwen_design_ref_audio');
            args.push('--voice_instruct', instruct);
            if (designRef) args.push('--ref_audio', designRef);
        } else {
            effectiveBatchSize = cloneBatchSize;
            const refAudio = localStorage.getItem('qwen_ref_audio_path');
            const refText = localStorage.getItem('qwen_ref_text');
            if (refAudio) args.push('--ref_audio', refAudio);
            if (refText) args.push('--qwen_ref_text', refText);
        }
    } else {
        const refAudio = localStorage.getItem('tts_ref_audio_path');
        if (refAudio) args.push('--ref_audio', refAudio);
    }

    return { args, effectiveBatchSize, blocked };
}
