import { useCallback, useEffect, useRef, useState } from 'react';
import { useBackendEvents } from './useBackendEvents';
import { useDubbingWorkflow } from './useDubbingWorkflow';
import { usePersistentSettings } from './usePersistentSettings';
import { useSubtitleImport } from './useSubtitleImport';
import { useTranslationWorkflow } from './useTranslationWorkflow';
import { saveOriginalSubtitleArtifact, saveSubtitleArtifacts } from '../utils/outputArtifacts';
import { runBackendCommand } from '../utils/backendCommandClient';
import { prepareSingleProjectPaths } from '../utils/projectPaths';
import { isBackendCanceledError } from '../utils/backendCancellation';
import { buildUserFacingErrorMessage, normalizeBackendError } from '../utils/backendErrors';
import { buildTestAsrCommand, buildWarmupTtsRuntimeCommand } from '../utils/backendCommandBuilders';
import { logUiError } from '../utils/frontendLogger';
import { appendStoredAsrArgs } from '../utils/runtimeSettings';
import { ASR_SERVICE_META, getAsrSourceLanguageConstraint, getAsrWorkflowBlockReason, resolveEffectiveAsrSourceLanguage, type AsrService } from '../utils/asrService';
import { getAsrExecutionPlan, getPostAlignmentBlockingReason } from '../utils/postAlignment';
import { cleanupSessionArtifacts } from '../utils/sessionCleanup';
import type { ModelStatusResponse } from '../types/backend';
import type { ExecutionConsoleEntry, RawBackendLogLine } from '../types/executionConsole';
import type { WorkflowOverviewModel, WorkflowStepState } from '../types/workflow';
import { getRuntimeCombinationNotice } from '../utils/runtimeCompatibility';
import { resolveSubtitleArtifactLanguages } from '../utils/languageTags';
import { persistSingleSubtitleArtifacts } from '../utils/singleSubtitlePersistence';

export interface Segment {
    start: number;
    end: number;
    text: string;
    speaker?: string;
    speaker_id?: string;
    utterance?: string;
    utterance_id?: string;
    utterance_index?: number;
    provider?: string;
    provider_meta?: Record<string, unknown>;
    audioPath?: string;
    audioStatus?: 'none' | 'generating' | 'ready' | 'error' | 'pending';
    audioDuration?: number;
    original_index?: number;
}

export type AudioMixMode = 'preserve_background' | 'replace_original';

function getTtsBlockingReasonFromStatus(
    result: ModelStatusResponse,
    service: 'indextts' | 'qwen',
    profile: string
): string | null {
    const status = result.status || {};
    const details = result.status_details || {};
    const readDetail = (key: string, fallback: string) => {
        if (!status[key]) {
            return details[key]?.detail || fallback;
        }
        return null;
    };

    if (service === 'indextts') {
        return readDetail('index_tts', 'Index-TTS 模型未就绪。');
    }

    const tokenizerIssue = readDetail('qwen_tokenizer', 'Qwen3-TTS tokenizer 未就绪。');
    if (tokenizerIssue) {
        return tokenizerIssue;
    }

    if (profile === 'fast') {
        return readDetail('qwen_06b_base', 'Qwen3-TTS 0.6B Base 未就绪。');
    }

    return readDetail('qwen_17b_base', 'Qwen3-TTS 1.7B Base 未就绪。');
}

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
    const [busyTask, setBusyTask] = useState<'asr' | 'translation' | 'merge' | null>(null);
    const [dubbingLoading, setDubbingLoading] = useState(false);
    const [progress, setProgress] = useState<number>(0);
    const [isIndeterminate, setIsIndeterminate] = useState<boolean>(false);
    const [videoStrategy, setVideoStrategy] = useState<string>(() => localStorage.getItem('videoStrategy') || 'auto_speedup');
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
    const warmedTtsServicesRef = useRef<Set<'indextts' | 'qwen'>>(new Set());
    const ttsSwitchingRef = useRef(false);
    const segmentsRef = useRef<Segment[]>([]);
    const translatedSegmentsRef = useRef<Segment[]>([]);
    const originalVideoPathRef = useRef('');
    const outputDirOverrideRef = useRef(outputDirOverride || '');
    const asrOriLangRef = useRef('Auto');
    const targetLangRef = useRef('中文');
    const subtitlePersistTimeoutRef = useRef<number | null>(null);
    const subtitlePersistTokenRef = useRef(0);

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
    useEffect(() => {
        localStorage.setItem('videoStrategy', videoStrategy);
    }, [videoStrategy]);
    useEffect(() => {
        segmentsRef.current = segments;
    }, [segments]);
    useEffect(() => {
        translatedSegmentsRef.current = translatedSegments;
    }, [translatedSegments]);
    useEffect(() => {
        originalVideoPathRef.current = originalVideoPath;
    }, [originalVideoPath]);
    useEffect(() => {
        outputDirOverrideRef.current = outputDirOverride || '';
    }, [outputDirOverride]);

    const {
        targetLang,
        setTargetLang,
        asrService,
        setAsrService,
        asrOriLang,
        setAsrOriLang,
        asrRuntimeSettings,
        setAsrRuntimeSettings,
        ttsService,
        setTtsService,
        asrModelProfiles,
        setAsrModelProfiles,
        ttsModelProfiles,
        setTtsModelProfiles,
        batchSize,
        setBatchSize,
        cloneBatchSize,
        setCloneBatchSize,
        maxNewTokens,
        setMaxNewTokens
    } = usePersistentSettings({ setFeedback });
    useEffect(() => {
        asrOriLangRef.current = asrOriLang;
    }, [asrOriLang]);
    useEffect(() => {
        targetLangRef.current = targetLang;
    }, [targetLang]);
    useEffect(() => () => {
        if (subtitlePersistTimeoutRef.current !== null) {
            window.clearTimeout(subtitlePersistTimeoutRef.current);
            subtitlePersistTimeoutRef.current = null;
        }
    }, []);

    const persistSingleSubtitleSnapshot = useCallback(async (
        sourceSubtitleSegments: Segment[],
        translatedSubtitleSegments: Segment[]
    ) => {
        await persistSingleSubtitleArtifacts({
            originalVideoPath: originalVideoPathRef.current,
            outputDirOverride: outputDirOverrideRef.current,
            asrOriLang: asrOriLangRef.current,
            targetLang: targetLangRef.current,
            sourceSegments: sourceSubtitleSegments,
            translatedSegments: translatedSubtitleSegments
        });
    }, []);

    const scheduleSingleSubtitlePersist = useCallback((
        sourceSubtitleSegments: Segment[],
        translatedSubtitleSegments: Segment[]
    ) => {
        if (subtitlePersistTimeoutRef.current !== null) {
            window.clearTimeout(subtitlePersistTimeoutRef.current);
        }

        const requestToken = subtitlePersistTokenRef.current + 1;
        subtitlePersistTokenRef.current = requestToken;

        subtitlePersistTimeoutRef.current = window.setTimeout(() => {
            subtitlePersistTimeoutRef.current = null;
            void persistSingleSubtitleSnapshot(sourceSubtitleSegments, translatedSubtitleSegments).catch((error: unknown) => {
                if (requestToken !== subtitlePersistTokenRef.current) {
                    return;
                }
                logUiError('实时保存字幕文件失败', {
                    domain: 'workflow.subtitle',
                    action: 'scheduleSingleSubtitlePersist',
                    detail: error instanceof Error ? error.message : String(error)
                });
                setStatus('字幕实时保存失败，请检查输出目录权限与文件占用。');
            });
        }, 250);
    }, [persistSingleSubtitleSnapshot]);

    const handleUpdateSourceSegment = useCallback((index: number, text: string) => {
        const nextSegments = segmentsRef.current.map((segment, segmentIndex) => (
            segmentIndex === index ? { ...segment, text } : segment
        ));
        segmentsRef.current = nextSegments;
        setSegments(nextSegments);
        scheduleSingleSubtitlePersist(nextSegments, translatedSegmentsRef.current);
    }, [scheduleSingleSubtitlePersist]);

    const handleUpdateTranslatedSegment = useCallback((index: number, text: string) => {
        const nextSegments = translatedSegmentsRef.current.map((segment, segmentIndex) => (
            segmentIndex === index ? { ...segment, text } : segment
        ));
        translatedSegmentsRef.current = nextSegments;
        setTranslatedSegments(nextSegments);
        scheduleSingleSubtitlePersist(segmentsRef.current, nextSegments);
    }, [scheduleSingleSubtitlePersist]);

    const handleUpdateSegmentTiming = useCallback((index: number, start: number, end: number) => {
        const clampedStart = Math.max(0, start);
        const clampedEnd = Math.max(clampedStart + 0.001, end);

        const nextSourceSegments = segmentsRef.current.map((segment, segmentIndex) => (
            segmentIndex === index ? { ...segment, start: clampedStart, end: clampedEnd } : segment
        ));
        const nextTranslatedSegments = translatedSegmentsRef.current.map((segment, segmentIndex) => (
            segmentIndex === index ? { ...segment, start: clampedStart, end: clampedEnd } : segment
        ));

        segmentsRef.current = nextSourceSegments;
        translatedSegmentsRef.current = nextTranslatedSegments;
        setSegments(nextSourceSegments);
        setTranslatedSegments(nextTranslatedSegments);
        scheduleSingleSubtitlePersist(nextSourceSegments, nextTranslatedSegments);
        setStatus(`已更新第 ${index + 1} 条字幕时间轴`);
    }, [scheduleSingleSubtitlePersist]);

    const handleAsrServiceChange = (newService: AsrService) => {
        const notice = getRuntimeCombinationNotice(newService, ttsService);
        if (notice) {
            setStatus(notice.message);
        }
        const meta = ASR_SERVICE_META[newService];
        if (meta.sourceLanguageMode === 'auto_only') {
            setAsrOriLang('Auto');
            asrOriLangRef.current = 'Auto';
            setStatus(`${meta.shortName} 当前接入只支持 Auto，已自动切回 Auto。`);
        }
        setAsrService(newService);
        return true;
    };

    const switchTtsRuntime = useCallback(async (newService: 'indextts' | 'qwen') => {
        if (ttsSwitchingRef.current) {
            setStatus('TTS 运行环境切换仍在进行中，请稍候。');
            return false;
        }
        const notice = getRuntimeCombinationNotice(asrService, newService);
        if (notice) {
            setStatus(notice.message);
        }

        if (newService === ttsService) {
            return true;
        }

        try {
            const modelStatus = await window.api.checkModelStatus() as ModelStatusResponse;
            if (modelStatus.success) {
                const blockingReason = getTtsBlockingReasonFromStatus(
                    modelStatus,
                    newService,
                    ttsModelProfiles[newService]
                );
                if (blockingReason) {
                    setFeedback({
                        title: 'TTS 模型未就绪',
                        message: `${blockingReason}\n\n请先在模型中心完成下载和校验，再切换到该 TTS 引擎。`,
                        type: 'error'
                    });
                    setStatus(blockingReason);
                    return false;
                }
            }
        } catch (error: unknown) {
            logUiError('切换前检查 TTS 模型状态失败', {
                domain: 'workflow.tts',
                action: 'switchTtsRuntime.preflight',
                detail: error instanceof Error ? error.message : String(error)
            });
        }

        if (warmedTtsServicesRef.current.has(newService)) {
            setTtsService(newService);
            setStatus(`${newService === 'qwen' ? 'Qwen3-TTS' : 'Index-TTS'} 已切换`);
            return true;
        }

        ttsSwitchingRef.current = true;
        setInstallingDeps(true);
        setDepsPackageName(newService === 'qwen' ? 'Qwen3 TTS Runtime' : 'IndexTTS Runtime');
        setStatus(`正在切换到 ${newService === 'qwen' ? 'Qwen3-TTS' : 'Index-TTS'} 运行环境...`);

        try {
            const result = await runBackendCommand(buildWarmupTtsRuntimeCommand({
                ttsService: newService,
                ttsModelProfile: ttsModelProfiles[newService],
                json: true
            }));

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

            warmedTtsServicesRef.current.add(newService);
            setTtsService(newService);
            setStatus(`${newService === 'qwen' ? 'Qwen3-TTS' : 'Index-TTS'} 运行环境已就绪`);
            return true;
        } catch (e: unknown) {
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
            ttsSwitchingRef.current = false;
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
        ttsModelProfiles,
        ttsService
    ]);

    useEffect(() => {
        warmedTtsServicesRef.current.add(ttsService);
    }, [ttsService]);

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
        asrOriLang,
        targetLang,
        setSegments,
        setTranslatedSegments,
        setStatus,
        setFeedback,
        onSourceSubtitleImported: async (importedSegments) => {
            segmentsRef.current = importedSegments;
            await persistSingleSubtitleSnapshot(importedSegments, translatedSegmentsRef.current);
        },
        onTranslatedSubtitleImported: async (importedSegments) => {
            translatedSegmentsRef.current = importedSegments;
            await persistSingleSubtitleSnapshot(segmentsRef.current, importedSegments);
        }
    });

    const {
        handleTranslate,
        handleReTranslate
    } = useTranslationWorkflow({
        segments,
        translatedSegments,
        targetLang,
        asrOriLang,
        loading,
        abortRef,
        setLoading,
        setIsIndeterminate,
        setProgress,
        setStatus,
        setTranslatedSegments,
        setFeedback,
        setRetranslatingSegmentId,
        setBusyTask,
        onTranslatedSegmentsCommitted: async (committedSegments) => {
            translatedSegmentsRef.current = committedSegments;
            await persistSingleSubtitleSnapshot(segmentsRef.current, committedSegments);
        }
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
        asrOriLang,
        ttsService,
        ttsModelProfile: ttsModelProfiles[ttsService],
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

    const getAsrBlockingReason = useCallback(async (): Promise<string | null> => {
        try {
            const executionPlan = getAsrExecutionPlan(asrService);
            const result = await window.api.checkModelStatus() as ModelStatusResponse;
            if (!result.success) {
                return result.error || '无法获取模型状态，请先在环境诊断页检查运行环境。';
            }

            const postAlignmentBlockReason = getPostAlignmentBlockingReason(executionPlan, result);
            if (postAlignmentBlockReason) {
                return postAlignmentBlockReason;
            }

            const status = result.status || {};
            const statusDetails = result.status_details || {};
            const readDetail = (key: string, fallback: string) => {
                if (!status[key]) {
                    return statusDetails[key]?.detail || fallback;
                }
                return null;
            };

            if (asrService === 'faster-whisper') {
                const runtimeIssue = readDetail('faster_whisper_runtime', 'faster-whisper Runtime 未就绪。');
                if (runtimeIssue) {
                    return runtimeIssue;
                }
                const profileKey = asrModelProfiles[asrService] === 'balanced'
                    ? 'faster_whisper_balanced_model'
                    : 'faster_whisper_model';
                return readDetail(profileKey, 'faster-whisper 模型未就绪。');
            }

            if (asrService === 'funasr') {
                const runtimeIssue = readDetail('funasr_runtime', 'FunASR Python runtime 未就绪。');
                if (runtimeIssue) {
                    return runtimeIssue;
                }
                const vadIssue = readDetail('funasr_vad', 'FunASR VAD 资源未就绪。');
                if (vadIssue) {
                    return vadIssue;
                }
                const puncIssue = readDetail('funasr_punc', 'FunASR punctuation 资源未就绪。');
                if (puncIssue) {
                    return puncIssue;
                }
                return readDetail('funasr_standard', 'FunASR acoustic model 未就绪。');
            }

            if (asrService === 'qwen') {
                const profileKey = asrModelProfiles[asrService] === 'fast'
                    ? 'qwen_asr_06b'
                    : 'qwen_asr_17b';
                return readDetail(profileKey, 'Qwen3-ASR 模型未就绪。');
            }

            if (asrService === 'vibevoice-asr') {
                return readDetail('vibevoice_asr_standard', 'VibeVoice-ASR 模型未就绪。');
            }

            return getAsrWorkflowBlockReason(asrService);
        } catch (error: unknown) {
            logUiError('检查 ASR 通道可执行性失败', {
                domain: 'workflow.asr',
                action: 'getAsrBlockingReason',
                detail: error instanceof Error ? error.message : String(error)
            });
            return '无法确认当前 ASR 通道状态，请先在环境诊断页执行检查。';
        }
    }, [asrModelProfiles, asrService]);

    const handleASR = async (): Promise<Segment[] | null> => {
        if (!originalVideoPath) {
            setStatus('请先上传或选择视频');
            return null;
        }

        const sourceLanguageConstraint = getAsrSourceLanguageConstraint(asrService, asrOriLang);
        if (sourceLanguageConstraint) {
            setStatus(sourceLanguageConstraint);
            setFeedback({
                title: '源语言设置不可执行',
                message: `${sourceLanguageConstraint}\n\n当前项目不会把不生效的源语言提示继续透传到后端。`,
                type: 'error'
            });
            return null;
        }

        const blockingReason = await getAsrBlockingReason();
        if (blockingReason) {
            setStatus(`当前 ASR 通道不可执行: ${blockingReason}`);
            setFeedback({
                title: 'ASR 通道不可执行',
                message: `${blockingReason}\n\n系统不会自动切换到其他 ASR provider。请前往环境诊断或模型中心处理后再重试。`,
                type: 'error'
            });
            return null;
        }

        setBusyTask('asr');
        setLoading(true);
        abortRef.current = false;
        setIsIndeterminate(true);
        setProgress(0);
        setStatus('正在识别字幕...');

        try {
            const { fileName, projectPaths } = await prepareSingleProjectPaths(
                originalVideoPath,
                outputDirOverride,
                resolveSubtitleArtifactLanguages(asrOriLang, targetLang)
            );
            const command = buildTestAsrCommand({
                input: originalVideoPath,
                asrService,
                asrModelProfile: asrModelProfiles[asrService],
                sourceLanguage: resolveEffectiveAsrSourceLanguage(asrService, asrOriLang),
                outputDir: projectPaths.sessionTempDir
            });
            appendStoredAsrArgs(command.args);
            const result = await runBackendCommand(command);

            if (abortRef.current) return null;

            if (!Array.isArray(result)) {
                const errorInfo = normalizeBackendError(result, '识别失败');
                setStatus(errorInfo.message || '识别失败');
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
            setTranslatedSegments([]);
            segmentsRef.current = result;
            translatedSegmentsRef.current = [];

            await saveOriginalSubtitleArtifact(
                projectPaths.finalDir,
                fileName,
                result.map((segment: Segment) => ({ start: segment.start, end: segment.end, text: segment.text })),
                resolveSubtitleArtifactLanguages(asrOriLang, targetLang)
            );

            setStatus('识别完成，请检查并编辑字幕。');
            return result;
        } catch (e: unknown) {
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
            setBusyTask(null);
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
            const { fileName, projectPaths } = await prepareSingleProjectPaths(
                originalVideoPath,
                outputDirOverride,
                resolveSubtitleArtifactLanguages(asrOriLang, targetLang)
            );
            await saveSubtitleArtifacts(
                projectPaths.finalDir,
                fileName,
                asrSegs.map(segment => ({ start: segment.start, end: segment.end, text: segment.text })),
                transSegs.map(segment => ({ start: segment.start, end: segment.end, text: segment.text })),
                resolveSubtitleArtifactLanguages(asrOriLang, targetLang)
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
            const { fileName, projectPaths } = await prepareSingleProjectPaths(
                originalVideoPath,
                outputDirOverride,
                resolveSubtitleArtifactLanguages(asrOriLang, targetLang)
            );
            await saveSubtitleArtifacts(
                projectPaths.finalDir,
                fileName,
                segments.map(segment => ({ start: segment.start, end: segment.end, text: segment.text })),
                transSegs.map(segment => ({ start: segment.start, end: segment.end, text: segment.text })),
                resolveSubtitleArtifactLanguages(asrOriLang, targetLang)
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
            if (originalVideoPath) {
                const { projectPaths } = await prepareSingleProjectPaths(
                    originalVideoPath,
                    outputDirOverride,
                    resolveSubtitleArtifactLanguages(asrOriLang, targetLang)
                );
                await cleanupSessionArtifacts(
                    {
                        sessionCacheDir: projectPaths.sessionCacheDir,
                        sessionAudioDir: projectPaths.sessionAudioDir
                    },
                    'interrupted'
                );
            }
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
            setBusyTask(null);
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
        busyTask,
        dubbingLoading, setDubbingLoading,
        generatingSegmentId, setGeneratingSegmentId,
        retranslatingSegmentId, setRetranslatingSegmentId,
        progress, setProgress,
        isIndeterminate, setIsIndeterminate,
        targetLang, setTargetLang,
        asrService, handleAsrServiceChange,
        asrModelProfiles, setAsrModelProfiles,
        asrOriLang,
        setAsrOriLang,
        asrRuntimeSettings, setAsrRuntimeSettings,
        ttsService, handleTtsServiceChange: switchTtsRuntime,
        ttsModelProfiles, setTtsModelProfiles,
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
        handleUpdateSourceSegment,
        handleUpdateSegmentTiming,
        handleUpdateTranslatedSegment,

        hasErrors,
        abortRef
    };
}
