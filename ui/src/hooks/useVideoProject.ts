import { useCallback, useEffect, useRef, useState } from 'react';
import { useBackendEvents } from './useBackendEvents';
import { useDubbingWorkflow } from './useDubbingWorkflow';
import { usePersistentSettings } from './usePersistentSettings';
import { useSubtitleImport } from './useSubtitleImport';
import { useTranslationWorkflow } from './useTranslationWorkflow';
import { saveSubtitleArtifacts } from '../utils/outputArtifacts';
import { prepareSingleProjectPaths } from '../utils/projectPaths';
import { isBackendCanceledError } from '../utils/backendCancellation';
import { buildUserFacingErrorMessage, normalizeBackendError } from '../utils/backendErrors';
import { logUiError } from '../utils/frontendLogger';
import { getStoredWhisperVadSettings } from '../utils/runtimeSettings';
import type { ExecutionConsoleEntry, RawBackendLogLine } from '../types/executionConsole';
import type { WorkflowOverviewModel, WorkflowStepState } from '../types/workflow';

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
    const MAX_CONSOLE_ENTRIES = 120;
    const MAX_RAW_LOG_LINES = 220;
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
    const [consoleEntries, setConsoleEntries] = useState<ExecutionConsoleEntry[]>([]);
    const [rawLogLines, setRawLogLines] = useState<RawBackendLogLine[]>([]);

    const abortRef = useRef(false);

    const pushConsoleEntry = useCallback((entry: Omit<ExecutionConsoleEntry, 'id' | 'timestamp'>) => {
        const timestamp = Date.now();
        const nextEntry: ExecutionConsoleEntry = {
            ...entry,
            id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp
        };

        setConsoleEntries(prev => {
            const latest = prev[0];
            if (
                latest
                && latest.level === nextEntry.level
                && latest.origin === nextEntry.origin
                && latest.title === nextEntry.title
                && latest.detail === nextEntry.detail
            ) {
                return prev;
            }
            return [nextEntry, ...prev].slice(0, MAX_CONSOLE_ENTRIES);
        });
    }, []);

    const pushRawLogLine = useCallback((line: Omit<RawBackendLogLine, 'id'>) => {
        const nextLine: RawBackendLogLine = {
            ...line,
            id: `${line.timestamp}-${Math.random().toString(36).slice(2, 8)}`
        };
        setRawLogLines(prev => [nextLine, ...prev].slice(0, MAX_RAW_LOG_LINES));
    }, []);

    const clearExecutionConsole = useCallback(() => {
        setConsoleEntries([]);
        setRawLogLines([]);
    }, []);

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

    const switchTtsRuntime = useCallback(async (newService: 'indextts' | 'qwen') => {
        const check = validateServiceIncompatibility(asrService, newService, 'tts');
        if (!check.valid) {
            setFeedback({ title: '选择冲突', message: check.message!, type: 'error' });
            return false;
        }

        if (newService === ttsService) {
            return true;
        }

        setInstallingDeps(true);
        setDepsPackageName(newService === 'qwen' ? 'Qwen3 TTS Runtime' : 'IndexTTS Runtime');
        setStatus(`正在切换到 ${newService === 'qwen' ? 'Qwen3-TTS' : 'Index-TTS'} 运行环境...`);

        try {
            await window.api.killBackend();
            const result = await window.api.runBackend([
                '--action', 'warmup_tts_runtime',
                '--tts_service', newService,
                '--json'
            ]);

            const errorInfo = normalizeBackendError(result, 'TTS 运行环境切换失败');
            if (!result || result.success !== true) {
                setFeedback({
                    title: '切换失败',
                    message: buildUserFacingErrorMessage(errorInfo),
                    type: 'error'
                });
                setStatus(buildUserFacingErrorMessage(errorInfo));
                return false;
            }

            setTtsService(newService);
            setStatus(`${newService === 'qwen' ? 'Qwen3-TTS' : 'Index-TTS'} 运行环境已就绪`);
            return true;
        } catch (e) {
            logUiError('切换 TTS 运行环境失败', {
                domain: 'workflow.tts',
                action: 'switchTtsRuntime',
                detail: e instanceof Error ? e.message : String(e)
            });
            const errorInfo = normalizeBackendError(e, 'TTS 运行环境切换失败');
            setFeedback({
                title: '切换失败',
                message: buildUserFacingErrorMessage(errorInfo),
                type: 'error'
            });
            setStatus(buildUserFacingErrorMessage(errorInfo));
            return false;
        } finally {
            setInstallingDeps(false);
            setDepsPackageName('');
        }
    }, [
        asrService,
        setDepsPackageName,
        setFeedback,
        setInstallingDeps,
        setStatus,
        setTtsService,
        ttsService
    ]);

    useBackendEvents({
        setIsIndeterminate,
        setProgress,
        setTranslatedSegments,
        setInstallingDeps,
        setDepsPackageName,
        setStatus,
        pushConsoleEntry,
        pushRawLogLine
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
                const errorInfo = normalizeBackendError(result, '识别失败：输出格式无效');
                setStatus('识别失败：输出格式无效');
                setFeedback({
                    title: '识别失败',
                    message: buildUserFacingErrorMessage(errorInfo),
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
            logUiError('识别流程发生异常', {
                domain: 'workflow.asr',
                action: 'handleASR',
                detail: e instanceof Error ? e.message : String(e)
            });
            const errorInfo = normalizeBackendError(e, '识别错误');
            setStatus(buildUserFacingErrorMessage(errorInfo));
            setFeedback({
                title: '识别错误',
                message: buildUserFacingErrorMessage(errorInfo),
                type: 'error'
            });
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
            logUiError('停止任务失败', {
                domain: 'workflow.control',
                action: 'handleStop',
                detail: e instanceof Error ? e.message : String(e)
            });
        } finally {
            setLoading(false);
            setDubbingLoading(false);
            setIsIndeterminate(false);
            setProgress(0);
            setGeneratingSegmentId(null);
        }
    };

    const latestIssue = consoleEntries.find(entry => entry.level === 'error' || entry.level === 'warn');
    const dubbedReadyCount = translatedSegments.filter(segment => segment.audioStatus === 'ready').length;
    const dubbedErrorCount = translatedSegments.filter(segment => segment.audioStatus === 'error').length;
    const hasPendingAudio = translatedSegments.some(segment => segment.audioStatus === 'pending' || segment.audioStatus === 'generating');
    const steps: WorkflowStepState[] = [
        {
            key: 'video',
            label: '视频准备',
            status: originalVideoPath ? 'done' : 'idle',
            detail: originalVideoPath ? '已加载源视频，可进入识别或导入字幕。' : '未加载视频，主流程尚未开始。'
        },
        {
            key: 'asr',
            label: '原字幕',
            status: loading && segments.length === 0
                ? 'active'
                : segments.length > 0
                    ? 'done'
                    : originalVideoPath
                        ? 'ready'
                        : 'idle',
            detail: segments.length > 0 ? `已准备 ${segments.length} 条原字幕。` : '可通过识别或导入 SRT 获取原字幕。'
        },
        {
            key: 'translation',
            label: '翻译字幕',
            status: loading && segments.length > 0 && translatedSegments.length === 0
                ? 'active'
                : translatedSegments.length > 0
                    ? 'done'
                    : segments.length > 0
                        ? 'ready'
                        : 'blocked',
            detail: translatedSegments.length > 0 ? `已准备 ${translatedSegments.length} 条翻译字幕。` : '依赖原字幕完成后才能继续。'
        },
        {
            key: 'dubbing',
            label: '配音生成',
            status: dubbingLoading || hasPendingAudio
                ? 'active'
                : dubbedErrorCount > 0
                    ? 'error'
                    : dubbedReadyCount > 0 && translatedSegments.length > 0
                        ? 'done'
                        : translatedSegments.length > 0
                            ? 'ready'
                            : 'blocked',
            detail: dubbedReadyCount > 0
                ? `可用 ${dubbedReadyCount} 条，失败 ${dubbedErrorCount} 条。`
                : '需先有翻译字幕，之后才能进入批量或单段配音。'
        },
        {
            key: 'merge',
            label: '视频合成',
            status: mergedVideoPath
                ? 'done'
                : dubbedReadyCount > 0 && dubbedErrorCount === 0
                    ? 'ready'
                    : 'blocked',
            detail: mergedVideoPath
                ? '已输出最终视频。'
                : dubbedReadyCount > 0 && dubbedErrorCount === 0
                    ? '当前已满足合成条件。'
                    : dubbedReadyCount > 0
                        ? '仍有失败片段，建议先修复后再合成。'
                        : '需要先完成可用配音。'
        }
    ];
    const activeStepKey = steps.find(step => step.status === 'active')?.key
        || steps.find(step => step.status === 'ready')?.key
        || (mergedVideoPath ? 'merge' : dubbedErrorCount > 0 ? 'dubbing' : translatedSegments.length > 0 ? 'dubbing' : segments.length > 0 ? 'translation' : originalVideoPath ? 'asr' : 'video');
    const blockers = [
        !originalVideoPath ? '尚未导入源视频' : '',
        originalVideoPath && segments.length === 0 ? '缺少原字幕' : '',
        segments.length > 0 && translatedSegments.length === 0 ? '缺少翻译字幕' : '',
        dubbedErrorCount > 0 ? `存在 ${dubbedErrorCount} 条失败配音` : ''
    ].filter(Boolean);
    const workflowOverview: WorkflowOverviewModel = {
        phase: mergedVideoPath
            ? 'completed'
            : loading || dubbingLoading || hasPendingAudio
                ? 'running'
                : dubbedErrorCount > 0
                    ? 'attention'
                    : originalVideoPath
                        ? 'ready'
                        : 'idle',
        activeStepKey,
        headline: !originalVideoPath
            ? '等待导入源视频'
            : mergedVideoPath
                ? '主流程已完成，结果可复核或导出'
                : hasPendingAudio || loading || dubbingLoading
                    ? '工作流正在推进中'
                    : '工作流已进入可继续处理状态',
        recommendation: !originalVideoPath
            ? '先选择视频，再决定是手动分步处理，还是直接启动一键流程。'
            : mergedVideoPath
                ? '可以复核合成结果、导出字幕，或调整参数后重新生成部分环节。'
                : segments.length === 0
                    ? '优先完成原字幕识别或导入原字幕，这是后续翻译和配音的基础数据。'
                    : translatedSegments.length === 0
                        ? '原字幕已就绪，下一步建议先生成或导入翻译字幕，再进入配音阶段。'
                        : dubbedReadyCount === 0
                            ? '翻译字幕已齐备，建议先生成全部配音，再根据失败片段执行局部重试。'
                            : dubbedErrorCount > 0
                                ? '已有部分配音可用，建议先重试失败片段，再执行最终合成。'
                                : '当前已经具备合成条件，可直接导出最终视频。',
        sourceCount: segments.length,
        translatedCount: translatedSegments.length,
        dubbedReadyCount,
        dubbedErrorCount,
        blockers,
        insights: [
            { label: '当前阶段', value: steps.find(step => step.key === activeStepKey)?.label || '视频准备', tone: mergedVideoPath ? 'success' : dubbedErrorCount > 0 ? 'danger' : loading || dubbingLoading ? 'info' : 'neutral' },
            { label: '恢复策略', value: dubbedErrorCount > 0 ? '优先重试失败片段' : dubbedReadyCount > 0 ? '可直接进入合成' : '等待上游完成', tone: dubbedErrorCount > 0 ? 'warning' : dubbedReadyCount > 0 ? 'success' : 'neutral' },
            { label: '处理进度', value: `${segments.length}/${translatedSegments.length}/${dubbedReadyCount}`, tone: translatedSegments.length === 0 ? 'warning' : dubbedErrorCount > 0 ? 'warning' : 'info' }
        ],
        latestIssue: latestIssue ? {
            title: latestIssue.title,
            traceId: latestIssue.traceId,
            category: latestIssue.category
        } : undefined,
        steps
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
        ttsService, handleTtsServiceChange: switchTtsRuntime,
        batchSize, setBatchSize,
        cloneBatchSize, setCloneBatchSize,
        maxNewTokens, setMaxNewTokens,
        feedback, setFeedback,
        installingDeps, setInstallingDeps,
        depsPackageName, setDepsPackageName,
        consoleEntries,
        rawLogLines,
        workflowOverview,
        clearExecutionConsole,

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
