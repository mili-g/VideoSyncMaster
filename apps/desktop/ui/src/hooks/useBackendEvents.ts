import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Segment } from './useVideoProject';
import type { ExecutionConsoleEntry, RawBackendLogLine } from '../types/executionConsole';
import type { BackendEventContext } from '../types/workflow';

interface PartialResultPayload {
    index?: number;
    audio_path?: string;
    success?: boolean;
    duration?: number;
    text?: string;
}

interface ProgressPayload {
    percent?: number;
    value?: number;
    stage?: string;
    stage_label?: string;
    item_index?: number;
    item_total?: number;
    message?: string;
    detail?: string;
}

interface StagePayload {
    stage?: string;
    stage_label?: string;
    status?: string;
    message?: string;
    detail?: string;
}

interface IssuePayload {
    level?: 'info' | 'warn' | 'error';
    stage?: string;
    code?: string;
    category?: string;
    retryable?: boolean;
    message?: string;
    detail?: string;
    suggestion?: string;
    item_index?: number;
    item_total?: number;
    context?: BackendEventContext;
}

interface BackendEventsOptions {
    setIsIndeterminate: Dispatch<SetStateAction<boolean>>;
    setProgress: Dispatch<SetStateAction<number>>;
    setTranslatedSegments: Dispatch<SetStateAction<Segment[]>>;
    setInstallingDeps: Dispatch<SetStateAction<boolean>>;
    setDepsPackageName: Dispatch<SetStateAction<string>>;
    setStatus: Dispatch<SetStateAction<string>>;
    pushConsoleEntry: (entry: Omit<ExecutionConsoleEntry, 'id' | 'timestamp'>) => void;
    pushRawLogLine: (line: Omit<RawBackendLogLine, 'id'>) => void;
}

export function useBackendEvents({
    setIsIndeterminate,
    setProgress,
    setTranslatedSegments,
    setInstallingDeps,
    setDepsPackageName,
    setStatus,
    pushConsoleEntry,
    pushRawLogLine
}: BackendEventsOptions) {
    const ttsProgressTotalRef = useRef<number | null>(null);
    const ttsProgressCompletedRef = useRef(0);
    const lastDetailedTtsStatusRef = useRef('');
    const lastProgressEntryRef = useRef('');

    useEffect(() => {
        const shouldPromoteRawLineToIssue = (line: RawBackendLogLine) => {
            if (line.level === 'error') {
                return true;
            }

            if (line.level !== 'warn') {
                return false;
            }

            if (line.logType === 'error' || line.logType === 'security') {
                return true;
            }

            return Boolean(line.code || typeof line.retryable === 'boolean');
        };

        const extractTtsTotal = (text: string) => {
            const match = text.match(/(\d+)\s*条/);
            return match ? Number(match[1]) : null;
        };

        const isTtsStage = (stage?: string, stageLabel?: string, text?: string) => {
            const normalized = `${stage || ''} ${stageLabel || ''} ${text || ''}`.toLowerCase();
            return normalized.includes('tts')
                || normalized.includes('配音')
                || normalized.includes('语音')
                || normalized.includes('synth')
                || normalized.includes('qwen')
                || normalized.includes('indextts');
        };

        const extractItemProgressToken = (text: string) => {
            const match = text.match(/第\s*\d+\s*\/\s*\d+\s*条/);
            return match ? match[0].replace(/\s+/g, '') : '';
        };

        const buildProgressStatus = (payload: ProgressPayload) => {
            const stageLabel = payload.stage_label || '';
            const hasItemProgress = typeof payload.item_index === 'number' && typeof payload.item_total === 'number';
            const itemText = hasItemProgress
                ? `第 ${payload.item_index}/${payload.item_total} 条语音合成`
                : '';
            const message = (payload.message || '').trim();
            const detail = (payload.detail || '').trim();
            const itemToken = extractItemProgressToken(itemText);

            const messageParts = [stageLabel];
            if (itemText) {
                messageParts.push(itemText);
            }
            if (message) {
                const messageToken = extractItemProgressToken(message);
                if (!itemToken || !messageToken || messageToken !== itemToken) {
                    messageParts.push(message);
                }
            }
            if (detail && detail !== message) {
                const detailToken = extractItemProgressToken(detail);
                if (!itemToken || !detailToken || detailToken !== itemToken) {
                    messageParts.push(detail);
                }
            }

            return messageParts.filter(Boolean).join(' - ');
        };

        const handleProgress = (value: unknown) => {
            const payload = (typeof value === 'number' ? { percent: value } : (value || {})) as ProgressPayload;
            const percent = typeof payload.percent === 'number'
                ? payload.percent
                : (typeof payload.value === 'number' ? payload.value : 0);
            setIsIndeterminate(false);
            setProgress(percent);

            if (typeof payload.item_total === 'number') {
                ttsProgressTotalRef.current = payload.item_total;
            }
            if (typeof payload.item_index === 'number') {
                ttsProgressCompletedRef.current = Math.max(0, payload.item_index - 1);
            }

            const statusText = buildProgressStatus(payload);
            if (statusText) {
                if (typeof payload.item_index === 'number' && typeof payload.item_total === 'number') {
                    lastDetailedTtsStatusRef.current = statusText;
                }
                setStatus(statusText);
                if (lastProgressEntryRef.current !== statusText) {
                    lastProgressEntryRef.current = statusText;
                pushConsoleEntry({
                    level: 'progress',
                    origin: 'progress',
                    title: statusText,
                    detail: payload.detail || payload.message || '',
                    stage: payload.stage || payload.stage_label
                });
                }
            }
        };

        const handleStage = (payload: StagePayload) => {
            const message = payload.message || '';
            const total = extractTtsTotal(message);
            if (total && (message.includes('IndexTTS') || message.includes('Qwen') || message.includes('配音'))) {
                ttsProgressTotalRef.current = total;
                ttsProgressCompletedRef.current = 0;
                const detailedStatus = `${payload.stage_label || '正在生成配音'} - 第 1/${total} 条语音合成`;
                lastDetailedTtsStatusRef.current = detailedStatus;
                setStatus(detailedStatus);
                pushConsoleEntry({
                    level: 'stage',
                    origin: 'stage',
                    title: payload.stage_label || '正在生成配音',
                    detail: message || payload.detail || '',
                    stage: payload.stage || payload.stage_label
                });
                return;
            }

            if (isTtsStage(payload.stage, payload.stage_label, `${payload.message || ''} ${payload.detail || ''}`) && lastDetailedTtsStatusRef.current) {
                setStatus(lastDetailedTtsStatusRef.current);
                return;
            }

            const parts = [payload.stage_label || '', payload.message || '', payload.detail || ''].filter(Boolean);
            if (parts.length > 0) {
                const nextStatus = parts.join(' - ');
                setStatus(nextStatus);
                pushConsoleEntry({
                    level: 'stage',
                    origin: 'stage',
                    title: payload.stage_label || payload.stage || '阶段更新',
                    detail: [payload.message || '', payload.detail || ''].filter(Boolean).join(' - '),
                    stage: payload.stage || payload.stage_label
                });
            }
        };

        const handleIssue = (payload: IssuePayload) => {
            const prefix = payload.level === 'error' ? '错误' : payload.level === 'warn' ? '警告' : '提示';
            const code = payload.code ? `[${payload.code}] ` : '';
            const itemText = (typeof payload.item_index === 'number' && typeof payload.item_total === 'number')
                ? `（第 ${payload.item_index}/${payload.item_total} 条）`
                : '';
            const suggestion = payload.suggestion ? `，建议：${payload.suggestion}` : '';
            const message = `${prefix}: ${code}${payload.message || '发生异常'}${itemText}${suggestion}`;
            const detailParts = [
                payload.detail || '',
                payload.category ? `分类：${payload.category}` : '',
                typeof payload.retryable === 'boolean' ? `可重试：${payload.retryable ? '是' : '否'}` : '',
                payload.context?.trace_id ? `Trace: ${payload.context.trace_id}` : '',
                payload.suggestion ? `建议：${payload.suggestion}` : ''
            ].filter(Boolean);
            setStatus(message);
            pushConsoleEntry({
                level: payload.level === 'error' ? 'error' : payload.level === 'warn' ? 'warn' : 'info',
                origin: 'issue',
                title: payload.message || '发生异常',
                detail: detailParts.join(' - '),
                stage: payload.stage,
                code: payload.code,
                category: payload.category,
                retryable: payload.retryable,
                traceId: payload.context?.trace_id,
                requestId: payload.context?.request_id,
                action: payload.context?.action
            });
        };

        const handlePartialResult = (_event: unknown, data: PartialResultPayload) => {
            if (data && typeof data.index === 'number') {
                const segmentIndex = data.index;
                setTranslatedSegments(prev => {
                    const newSegs = [...prev];
                    if (newSegs[segmentIndex]) {
                        if (data.audio_path !== undefined) {
                            const isSuccess = data.success === true;
                            let status: 'ready' | 'error' = isSuccess ? 'ready' : 'error';

                            if (isSuccess && data.duration) {
                                const seg = newSegs[segmentIndex];
                                const expectedDur = seg.end - seg.start;
                                if (data.duration - expectedDur > 5.0) status = 'error';
                            }

                            if (isSuccess && !data.audio_path) status = 'error';

                            newSegs[segmentIndex] = {
                                ...newSegs[segmentIndex],
                                audioPath: data.audio_path,
                                audioStatus: status,
                                audioDuration: data.duration
                            };
                        }

                        if (data.text !== undefined) {
                            newSegs[segmentIndex] = {
                                ...newSegs[segmentIndex],
                                text: data.text
                            };
                        }
                    }
                    return newSegs;
                });

                if (typeof ttsProgressTotalRef.current === 'number' && ttsProgressTotalRef.current > 0) {
                    ttsProgressCompletedRef.current = Math.min(
                        ttsProgressCompletedRef.current + 1,
                        ttsProgressTotalRef.current
                    );
                    const nextIndex = Math.min(
                        ttsProgressCompletedRef.current + 1,
                        ttsProgressTotalRef.current
                    );
                    const detailedStatus =
                        ttsProgressCompletedRef.current >= ttsProgressTotalRef.current
                            ? `正在生成配音 - 已完成 ${ttsProgressTotalRef.current}/${ttsProgressTotalRef.current} 条语音`
                            : `正在生成配音 - 第 ${nextIndex}/${ttsProgressTotalRef.current} 条语音合成`
                    lastDetailedTtsStatusRef.current = detailedStatus;
                    setStatus(detailedStatus);
                }
            }
        };

        const handleDepsInstalling = (pkgName: string) => {
            setInstallingDeps(true);
            setDepsPackageName(pkgName);
            setStatus(`正在安装或切换依赖: ${pkgName}`);
            pushConsoleEntry({
                level: 'stage',
                origin: 'deps',
                title: '依赖环境切换中',
                detail: pkgName
            });
        };

        const handleDepsDone = () => {
            setInstallingDeps(false);
            setDepsPackageName('');
            pushConsoleEntry({
                level: 'stage',
                origin: 'deps',
                title: '依赖环境就绪'
            });
        };

        const handleLogLine = (line: RawBackendLogLine) => {
            pushRawLogLine(line);
            if (shouldPromoteRawLineToIssue(line)) {
                pushConsoleEntry({
                    level: line.level,
                    origin: 'raw',
                    title: line.text,
                    detail: [
                        `${line.source} · ${line.lane}`,
                        line.logType ? `类型: ${line.logType}` : '',
                        line.domain ? `域: ${line.domain}` : '',
                        line.stage ? `阶段: ${line.stage}` : '',
                        line.code ? `编码: ${line.code}` : '',
                        typeof line.retryable === 'boolean' ? `可重试: ${line.retryable ? '是' : '否'}` : '',
                        line.traceId ? `Trace: ${line.traceId}` : ''
                    ].filter(Boolean).join(' · ') || line.detail,
                    code: line.code,
                    category: line.logType,
                    retryable: line.retryable,
                    traceId: line.traceId,
                    requestId: line.requestId,
                    action: line.action
                });
            }
        };

        const offProgress = window.api.onBackendProgress(handleProgress);
        const offStage = window.api.onBackendStage((data) => handleStage((data || {}) as StagePayload));
        const offIssue = window.api.onBackendIssue((data) => handleIssue((data || {}) as IssuePayload));
        const offPartial = window.api.onBackendPartialResult((data) => handlePartialResult(undefined, data as PartialResultPayload));
        const offDepsInstalling = window.api.onBackendDepsInstalling(handleDepsInstalling);
        const offDepsDone = window.api.onBackendDepsDone(handleDepsDone);
        const offLogLine = window.api.onBackendLogLine((line) => handleLogLine(line as RawBackendLogLine));

        return () => {
            offProgress();
            offStage();
            offIssue();
            offPartial();
            offDepsInstalling();
            offDepsDone();
            offLogLine();
        };
    }, [pushConsoleEntry, pushRawLogLine, setDepsPackageName, setInstallingDeps, setIsIndeterminate, setProgress, setStatus, setTranslatedSegments]);
}
