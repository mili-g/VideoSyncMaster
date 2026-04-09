import { useEffect } from 'react';
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
    useEffect(() => {
        const handleProgress = (value: unknown) => {
            const payload = (typeof value === 'number' ? { percent: value } : (value || {})) as ProgressPayload;
            const percent = typeof payload.percent === 'number'
                ? payload.percent
                : (typeof payload.value === 'number' ? payload.value : 0);
            setIsIndeterminate(false);
            setProgress(percent);

            const stageLabel = payload.stage_label || '';
            const itemText = (typeof payload.item_index === 'number' && typeof payload.item_total === 'number')
                ? `第 ${payload.item_index}/${payload.item_total} 条`
                : '';
            const parts = [stageLabel, payload.message || itemText, payload.detail || ''].filter(Boolean);
            if (parts.length > 0) {
                setStatus(parts.join(' - '));
            }
        };

        const handleStage = (payload: StagePayload) => {
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
