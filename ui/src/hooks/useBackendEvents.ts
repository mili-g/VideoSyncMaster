import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Segment } from './useVideoProject';

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
    message?: string;
    detail?: string;
    suggestion?: string;
    item_index?: number;
    item_total?: number;
}

interface BackendEventsOptions {
    setIsIndeterminate: Dispatch<SetStateAction<boolean>>;
    setProgress: Dispatch<SetStateAction<number>>;
    setTranslatedSegments: Dispatch<SetStateAction<Segment[]>>;
    setInstallingDeps: Dispatch<SetStateAction<boolean>>;
    setDepsPackageName: Dispatch<SetStateAction<string>>;
    setStatus: Dispatch<SetStateAction<string>>;
}

export function useBackendEvents({
    setIsIndeterminate,
    setProgress,
    setTranslatedSegments,
    setInstallingDeps,
    setDepsPackageName,
    setStatus
}: BackendEventsOptions) {
    const ttsProgressTotalRef = useRef<number | null>(null);
    const ttsProgressCompletedRef = useRef(0);

    useEffect(() => {
        const extractTtsTotal = (text: string) => {
            const match = text.match(/(\d+)\s*条/);
            return match ? Number(match[1]) : null;
        };

        const buildProgressStatus = (payload: ProgressPayload) => {
            const stageLabel = payload.stage_label || '';
            const hasItemProgress = typeof payload.item_index === 'number' && typeof payload.item_total === 'number';
            const itemText = hasItemProgress
                ? `第 ${payload.item_index}/${payload.item_total} 条语音合成`
                : '';
            const message = (payload.message || '').trim();

            const messageParts = [stageLabel];
            if (itemText) {
                messageParts.push(itemText);
            } else if (message) {
                messageParts.push(message);
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
                setStatus(statusText);
            }
        };

        const handleStage = (payload: StagePayload) => {
            const message = payload.message || '';
            const total = extractTtsTotal(message);
            if (total && (message.includes('IndexTTS') || message.includes('Qwen') || message.includes('配音'))) {
                ttsProgressTotalRef.current = total;
                ttsProgressCompletedRef.current = 0;
                setStatus(`${payload.stage_label || '正在生成配音'} - 第 1/${total} 条语音合成`);
                return;
            }

            const parts = [payload.stage_label || '', payload.message || '', payload.detail || ''].filter(Boolean);
            if (parts.length > 0) {
                setStatus(parts.join(' - '));
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
            setStatus(message);
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
                    setStatus(
                        ttsProgressCompletedRef.current >= ttsProgressTotalRef.current
                            ? `正在生成配音 - 已完成 ${ttsProgressTotalRef.current}/${ttsProgressTotalRef.current} 条语音`
                            : `正在生成配音 - 第 ${nextIndex}/${ttsProgressTotalRef.current} 条语音合成`
                    );
                }
            }
        };

        const handleDepsInstalling = (pkgName: string) => {
            setInstallingDeps(true);
            setDepsPackageName(pkgName);
            setStatus(`正在安装或切换依赖: ${pkgName}`);
        };

        const handleDepsDone = () => {
            setInstallingDeps(false);
            setDepsPackageName('');
        };

        const offProgress = window.api.onBackendProgress(handleProgress);
        const offStage = window.api.onBackendStage((data) => handleStage((data || {}) as StagePayload));
        const offIssue = window.api.onBackendIssue((data) => handleIssue((data || {}) as IssuePayload));
        const offPartial = window.api.onBackendPartialResult((data) => handlePartialResult(undefined, data as PartialResultPayload));
        const offDepsInstalling = window.api.onBackendDepsInstalling(handleDepsInstalling);
        const offDepsDone = window.api.onBackendDepsDone(handleDepsDone);

        return () => {
            offProgress();
            offStage();
            offIssue();
            offPartial();
            offDepsInstalling();
            offDepsDone();
        };
    }, [setDepsPackageName, setInstallingDeps, setIsIndeterminate, setProgress, setStatus, setTranslatedSegments]);
}
