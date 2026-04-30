import { getStoredQwenTtsSettings, getStoredTtsVoiceMode } from './runtimeSettings';
import { getStoredTtsModelProfile } from './modelProfiles';
import { buildPrepareReferenceAudioCommand } from './backendCommandBuilders';
import { runBackendCommand } from './backendCommandClient';
import type { BackendCommandSpec } from './backendCommandClient';
import { BACKEND_ACTIONS, withBackendAction } from '../types/backendCommands';

export interface DubbingSegmentLike {
    start: number;
    end: number;
    text: string;
    audioPath?: string;
    audioStatus?: string;
    path?: string;
}

export interface DubbingFeedbackPayload {
    title: string;
    message: string;
    type: 'success' | 'error';
}

export interface FallbackReferenceAudio {
    audioPath: string;
    refText: string;
}

export interface TtsRequestOptions {
    targetLang: string;
    ttsService: 'indextts' | 'qwen';
    batchSize: number;
    cloneBatchSize: number;
    maxNewTokens: number;
    videoStrategy: string;
    audioMixMode?: 'preserve_background' | 'replace_original';
    fallbackRefAudio?: string;
    fallbackRefText?: string;
    nearbyRefAudios?: Array<{ audio_path: string; ref_text?: string }>;
    qwenRefText?: string;
}

export function collectNearbySuccessfulAudioRefs<T extends DubbingSegmentLike>(
    segments: T[],
    index: number,
    maxRefs = 2
) {
    const candidates = segments
        .map((segment, candidateIndex) => ({
            distance: Math.abs(candidateIndex - index),
            path: segment.audioPath || segment.path,
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

export async function prepareFallbackReferenceAudio<T extends Pick<DubbingSegmentLike, 'start' | 'end' | 'text'>>(
    sourcePath: string,
    workDir: string,
    segments: T[],
    lane: 'default' | 'prep' = 'default'
): Promise<FallbackReferenceAudio | undefined> {
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
        const result = await runBackendCommand(buildPrepareReferenceAudioCommand({
            input: sourcePath,
            ref: refJsonPath,
            output: workDir,
            json: true
        }), { lane });
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

export function buildTtsExtraArgs(
    ttsService: 'indextts' | 'qwen',
    batchSize: number,
    cloneBatchSize: number
) {
    const args: string[] = [];
    const voiceMode = getStoredTtsVoiceMode();
    let effectiveBatchSize = batchSize;
    let blocked: DubbingFeedbackPayload | null = null;

    args.push('--voice_mode', voiceMode);
    args.push('--tts_model_profile', getStoredTtsModelProfile(ttsService));

    if (ttsService === 'qwen') {
        const qwenSettings = getStoredQwenTtsSettings();
        const selectedQwenMode = qwenSettings.mode;

        if (selectedQwenMode === 'design' && !qwenSettings.designRefAudio) {
            blocked = {
                title: '需要预览',
                message: '您还没有完成“声音设计”测试音频。请先在参数设置中点击“合成”，锁定音色效果后再批量生成。',
                type: 'error'
            };
            return { args, effectiveBatchSize, blocked, voiceMode };
        }

        args.push('--qwen_mode', selectedQwenMode);
        args.push('--qwen_model_size', qwenSettings.modelSize);

        if (selectedQwenMode === 'preset') {
            args.push('--preset_voice', qwenSettings.presetVoice);
        } else if (selectedQwenMode === 'design') {
            args.push('--voice_instruct', qwenSettings.voiceInstruction);
            if (qwenSettings.designRefAudio) args.push('--ref_audio', qwenSettings.designRefAudio);
        } else {
            effectiveBatchSize = voiceMode === 'clone' ? cloneBatchSize : batchSize;
            if (qwenSettings.refAudio) args.push('--ref_audio', qwenSettings.refAudio);
            if (qwenSettings.refText) args.push('--qwen_ref_text', qwenSettings.refText);
        }
    } else {
        const refAudio = localStorage.getItem('tts_ref_audio_path');
        if (refAudio) args.push('--ref_audio', refAudio);
    }

    return { args, effectiveBatchSize, blocked, voiceMode };
}

export function buildSingleTtsArgs(
    sourcePath: string,
    outputPath: string,
    segment: Pick<DubbingSegmentLike, 'start' | 'end' | 'text'>,
    options: TtsRequestOptions
) {
    const { args: extraArgs } = buildTtsExtraArgs(options.ttsService, options.batchSize, options.cloneBatchSize);
    const args = withBackendAction(
        BACKEND_ACTIONS.GENERATE_SINGLE_TTS,
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
    );

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

    return { action: BACKEND_ACTIONS.GENERATE_SINGLE_TTS, args } satisfies BackendCommandSpec<typeof BACKEND_ACTIONS.GENERATE_SINGLE_TTS>;
}

export function buildBatchTtsArgs(
    sourcePath: string,
    outputDir: string,
    refJsonPath: string,
    options: TtsRequestOptions,
    resumeCompleted = 0,
    resumeTotal = 0
) {
    const { args: extraArgs, effectiveBatchSize } = buildTtsExtraArgs(options.ttsService, options.batchSize, options.cloneBatchSize);
    return {
        action: BACKEND_ACTIONS.GENERATE_BATCH_TTS,
        args: withBackendAction(
        BACKEND_ACTIONS.GENERATE_BATCH_TTS,
        '--input', sourcePath,
        '--output', outputDir,
        '--ref', refJsonPath,
        '--tts_service', options.ttsService,
        '--strategy', options.videoStrategy,
        '--audio_mix_mode', options.audioMixMode || 'preserve_background',
        '--batch_size', String(effectiveBatchSize),
        '--max_new_tokens', String(options.maxNewTokens),
        '--dub_retry_attempts', '3',
        '--resume_completed', String(Math.max(0, resumeCompleted)),
        '--resume_total', String(Math.max(0, resumeTotal)),
        '--lang', options.targetLang,
        '--json',
        ...extraArgs
        )
    } satisfies BackendCommandSpec<typeof BACKEND_ACTIONS.GENERATE_BATCH_TTS>;
}

export async function recoverExistingAudioSegments<T extends DubbingSegmentLike>(
    segments: T[],
    sessionAudioDir: string,
    preferredPaths: string[] = [],
    targetField: 'audioPath' | 'path' = 'path'
) {
    const preferredByIndex = new Map<number, string>();
    for (const candidatePath of preferredPaths) {
        const match = candidatePath.match(/segment(_retry)?_(\d+)\.wav$/i);
        if (!match) continue;
        const index = Number(match[2]);
        const shouldOverride = match[1] === '_retry' || !preferredByIndex.has(index);
        if (Number.isFinite(index) && shouldOverride) {
            preferredByIndex.set(index, candidatePath);
        }
    }

    const recovered = await Promise.all(segments.map(async (segment, index) => {
        const candidatePaths = [
            preferredByIndex.get(index),
            `${sessionAudioDir}\\segment_retry_${index}.wav`,
            `${sessionAudioDir}\\segment_${index}.wav`
        ].filter((path): path is string => Boolean(path));

        for (const candidatePath of candidatePaths) {
            const exists = await window.api.checkFileExists(candidatePath);
            if (!exists) continue;
            segment[targetField] = candidatePath as T['audioPath'] & T['path'];
            segment.audioStatus = 'ready';
            return true;
        }

        return false;
    }));

    return recovered.filter(Boolean).length;
}
