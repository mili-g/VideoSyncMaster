import { useEffect, useRef, useState } from 'react';
import { useBackendEvents } from './useBackendEvents';
import { useDubbingWorkflow } from './useDubbingWorkflow';
import { usePersistentSettings } from './usePersistentSettings';
import { useSubtitleImport } from './useSubtitleImport';
import { useTranslationWorkflow } from './useTranslationWorkflow';
import { saveSubtitleArtifacts } from '../utils/outputArtifacts';
import { prepareSingleProjectPaths } from '../utils/projectPaths';
import { isBackendCanceledError } from '../utils/backendCancellation';
import { getStoredWhisperVadSettings } from '../utils/runtimeSettings';

export interface Segment {
    start: number;
    end: number;
    text: string;
    audioPath?: string;
    audioStatus?: 'none' | 'generating' | 'ready' | 'error' | 'pending';
    audioDuration?: number;
    original_index?: number;
}

export type AudioMixMode = 'preserve_background' | 'replace_original';

interface UseVideoProjectOptions {
    outputDirOverride?: string;
}

export function useVideoProject({ outputDirOverride }: UseVideoProjectOptions = {}) {
    const [videoPath, setVideoPath] = useState<string>('');
    const [originalVideoPath, setOriginalVideoPath] = useState<string>('');
    const [mergedVideoPath, setMergedVideoPath] = useState<string>('');
    const [segments, setSegments] = useState<Segment[]>([]);
    const [translatedSegments, setTranslatedSegments] = useState<Segment[]>([]);

    const [status, setStatus] = useState('');
    const [loading, setLoading] = useState(false);
    const [dubbingLoading, setDubbingLoading] = useState(false);
    const [progress, setProgress] = useState<number>(0);
    const [isIndeterminate, setIsIndeterminate] = useState<boolean>(false);
    const [videoStrategy, setVideoStrategy] = useState<string>('auto_speedup');
    const [audioMixMode, setAudioMixMode] = useState<AudioMixMode>(() => {
        const saved = localStorage.getItem('audioMixMode');
        return saved === 'replace_original' ? 'replace_original' : 'preserve_background';
    });
    const [generatingSegmentId, setGeneratingSegmentId] = useState<number | null>(null);
    const [retranslatingSegmentId, setRetranslatingSegmentId] = useState<number | null>(null);

    const [feedback, setFeedback] = useState<{ title: string; message: string; type: 'success' | 'error' } | null>(null);
    const [installingDeps, setInstallingDeps] = useState(false);
    const [depsPackageName, setDepsPackageName] = useState('');

    const abortRef = useRef(false);

    useEffect(() => {
        localStorage.setItem('audioMixMode', audioMixMode);
    }, [audioMixMode]);

    const {
        targetLang,
        setTargetLang,
        asrService,
        setAsrService,
        asrOriLang,
        ttsService,
        setTtsService,
        batchSize,
        setBatchSize,
        cloneBatchSize,
        setCloneBatchSize,
        maxNewTokens,
        setMaxNewTokens
    } = usePersistentSettings({ setFeedback });

    const validateServiceIncompatibility = (asr: string, tts: string, changing: 'asr' | 'tts'): { valid: boolean; message?: string } => {
        if (asr === 'qwen' && tts === 'indextts') {
            if (changing === 'asr') {
                return {
                    valid: false,
                    message: 'Qwen3 ASR 与 Index-TTS 目前不能同时启用，请先在配音配置中切换 TTS 引擎。'
                };
            }

            return {
                valid: false,
                message: 'Index-TTS 与 Qwen3 ASR 目前不能同时启用，请先在识别配置中切换 ASR 引擎。'
            };
        }

        return { valid: true };
    };

    const handleAsrServiceChange = (newService: string) => {
        const check = validateServiceIncompatibility(newService, ttsService, 'asr');
        if (!check.valid) {
            setFeedback({ title: '选择冲突', message: check.message!, type: 'error' });
            return false;
        }

        setAsrService(newService);
        return true;
    };

    const handleTtsServiceChange = (newService: 'indextts' | 'qwen') => {
        const check = validateServiceIncompatibility(asrService, newService, 'tts');
        if (!check.valid) {
            setFeedback({ title: '选择冲突', message: check.message!, type: 'error' });
            return false;
        }

        setTtsService(newService);
        return true;
    };

    useBackendEvents({
        setIsIndeterminate,
        setProgress,
        setTranslatedSegments,
        setInstallingDeps,
        setDepsPackageName,
        setStatus
    });

    const {
        parseSRTContent,
        handleSRTUpload,
        handleTargetSRTUpload
    } = useSubtitleImport({
        originalVideoPath,
        setSegments,
        setTranslatedSegments,
        setStatus
    });

    const {
        handleTranslate,
        handleReTranslate
    } = useTranslationWorkflow({
        segments,
        translatedSegments,
        targetLang,
        loading,
        abortRef,
        setLoading,
        setIsIndeterminate,
        setProgress,
        setStatus,
        setTranslatedSegments,
        setFeedback,
        setRetranslatingSegmentId
    });

    const {
        hasErrors,
        handleRetryErrors,
        handleGenerateSingleDubbing,
        handleGenerateAllDubbing,
        handleMergeVideo
    } = useDubbingWorkflow({
        originalVideoPath,
        sourceSegments: segments,
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
    });

    const handleASR = async (): Promise<Segment[] | null> => {
        if (!originalVideoPath) {
            setStatus('请先上传或选择视频');
            return null;
        }

        setLoading(true);
        abortRef.current = false;
        setIsIndeterminate(true);
        setProgress(0);
        setStatus('正在识别字幕...');

        try {
            const { fileName, projectPaths } = await prepareSingleProjectPaths(originalVideoPath, outputDirOverride);
            const vad = getStoredWhisperVadSettings();

            const result = await window.api.runBackend([
                '--action', 'test_asr',
                '--input', originalVideoPath,
                '--asr', asrService,
                '--ori_lang', (asrOriLang === 'None' || asrOriLang === 'Auto') ? '' : asrOriLang,
                '--output_dir', projectPaths.sessionTempDir,
                '--vad_onset', vad.onset,
                '--vad_offset', vad.offset
            ]);

            if (abortRef.current) return null;

            if (!Array.isArray(result)) {
                setStatus('识别失败：输出格式无效');
                setFeedback({
                    title: '识别失败',
                    message: '识别结果格式无效，请检查所选 ASR 引擎或后端日志。',
                    type: 'error'
                });
                return null;
            }

            if (result.length === 0) {
                setStatus('识别失败：未检测到有效字幕片段');
                setFeedback({
                    title: '未生成字幕',
                    message: '当前视频未识别到可用字幕片段。请优先将源语言设为 Auto 或与视频语种一致后重试；若仍为空，请检查模型与后端日志。',
                    type: 'error'
                });
                return null;
            }

            result.sort((a: Segment, b: Segment) => a.start - b.start);
            setSegments(result);

            await saveSubtitleArtifacts(
                projectPaths.finalDir,
                fileName,
                result.map((segment: Segment) => ({ start: segment.start, end: segment.end, text: segment.text })),
                result.map((segment: Segment) => ({ start: segment.start, end: segment.end, text: segment.text }))
            );

            setStatus('识别完成，请检查并编辑字幕。');
            return result;
        } catch (e: any) {
            if (abortRef.current || isBackendCanceledError(e)) {
                setStatus('任务已由用户停止');
                return null;
            }
            console.error(e);
            setStatus(`识别错误: ${e.message}`);
            return null;
        } finally {
            if (!abortRef.current) {
                setLoading(false);
                setIsIndeterminate(false);
                setProgress(0);
            }
        }
    };

    const handleOneClickRun = async () => {
        if (!originalVideoPath) {
            setStatus('请先选择视频');
            return;
        }

        abortRef.current = false;

        const asrSegs = await handleASR();
        if (!asrSegs) return;

        const transSegs = await handleTranslate(asrSegs);
        if (!transSegs) return;

        {
            const { fileName, projectPaths } = await prepareSingleProjectPaths(originalVideoPath, outputDirOverride);
            await saveSubtitleArtifacts(
                projectPaths.finalDir,
                fileName,
                asrSegs.map(segment => ({ start: segment.start, end: segment.end, text: segment.text })),
                transSegs.map(segment => ({ start: segment.start, end: segment.end, text: segment.text }))
            );
        }

        const dubbedSegs = await handleGenerateAllDubbing(transSegs);
        if (!dubbedSegs) return;

        setStatus('等待文件写入...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        await handleMergeVideo(dubbedSegs);
    };

    const handleTranslateAndDub = async () => {
        abortRef.current = false;

        const transSegs = await handleTranslate();
        if (!transSegs) return;

        if (segments.length > 0) {
            const { fileName, projectPaths } = await prepareSingleProjectPaths(originalVideoPath, outputDirOverride);
            await saveSubtitleArtifacts(
                projectPaths.finalDir,
                fileName,
                segments.map(segment => ({ start: segment.start, end: segment.end, text: segment.text })),
                transSegs.map(segment => ({ start: segment.start, end: segment.end, text: segment.text }))
            );
        }

        const dubbedSegs = await handleGenerateAllDubbing(transSegs);
        if (!dubbedSegs) return;

        await handleMergeVideo(dubbedSegs);
    };

    const handleStop = async () => {
        abortRef.current = true;

        try {
            await window.api.killBackend();
            setStatus('任务已由用户停止');
        } catch (e) {
            console.error('Stop failed', e);
        } finally {
            setLoading(false);
            setDubbingLoading(false);
            setIsIndeterminate(false);
            setProgress(0);
            setGeneratingSegmentId(null);
        }
    };

    return {
        videoPath, setVideoPath,
        originalVideoPath, setOriginalVideoPath,
        mergedVideoPath, setMergedVideoPath,
        segments, setSegments,
        translatedSegments, setTranslatedSegments,
        videoStrategy, setVideoStrategy,
        audioMixMode, setAudioMixMode,
        status, setStatus,
        loading, setLoading,
        dubbingLoading, setDubbingLoading,
        generatingSegmentId, setGeneratingSegmentId,
        retranslatingSegmentId, setRetranslatingSegmentId,
        progress, setProgress,
        isIndeterminate, setIsIndeterminate,
        targetLang, setTargetLang,
        asrService, handleAsrServiceChange,
        asrOriLang,
        ttsService, handleTtsServiceChange,
        batchSize, setBatchSize,
        cloneBatchSize, setCloneBatchSize,
        maxNewTokens, setMaxNewTokens,
        feedback, setFeedback,
        installingDeps, setInstallingDeps,
        depsPackageName, setDepsPackageName,

        handleASR,
        handleTranslate,
        handleReTranslate,
        handleRetryErrors,
        handleGenerateSingleDubbing,
        handleGenerateAllDubbing,
        handleMergeVideo,
        parseSRTContent,
        handleSRTUpload,
        handleTargetSRTUpload,
        handleOneClickRun,
        handleTranslateAndDub,
        handleStop,

        hasErrors,
        abortRef
    };
}
