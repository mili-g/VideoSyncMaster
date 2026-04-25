import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Segment } from './useVideoProject';
import { isBackendCanceledError } from '../utils/backendCancellation';
import { buildUserFacingErrorMessage, normalizeBackendError } from '../utils/backendErrors';
import { logUiError, logUiWarn } from '../utils/frontendLogger';
import { appendStoredTranslationArgs } from '../utils/runtimeSettings';

type FeedbackType = 'success' | 'error';

interface FeedbackPayload {
    title: string;
    message: string;
    type: FeedbackType;
}

interface TranslationWorkflowOptions {
    segments: Segment[];
    translatedSegments: Segment[];
    targetLang: string;
    loading: boolean;
    abortRef: MutableRefObject<boolean>;
    setLoading: Dispatch<SetStateAction<boolean>>;
    setIsIndeterminate: Dispatch<SetStateAction<boolean>>;
    setProgress: Dispatch<SetStateAction<number>>;
    setStatus: Dispatch<SetStateAction<string>>;
    setTranslatedSegments: Dispatch<SetStateAction<Segment[]>>;
    setFeedback: Dispatch<SetStateAction<FeedbackPayload | null>>;
    setRetranslatingSegmentId: Dispatch<SetStateAction<number | null>>;
}

export function useTranslationWorkflow({
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
}: TranslationWorkflowOptions) {
    const handleTranslate = async (overrideSegments?: Segment[]): Promise<Segment[] | null> => {
        const segsToUse = overrideSegments || segments;
        if (segsToUse.length === 0) return null;

        setLoading(true);
        abortRef.current = false;
        setIsIndeterminate(true);
        setProgress(0);
        setStatus(`正在翻译 ${segsToUse.length} 个片段到 ${targetLang}...`);

        const placeholders = segsToUse.map(seg => ({
            ...seg,
            text: '...',
            audioPath: undefined,
            audioStatus: undefined
        }));
        setTranslatedSegments(placeholders);

        try {
            if (abortRef.current) return null;

            const inputJson = JSON.stringify(segsToUse);
            const args = [
                '--action', 'translate_text',
                '--input', inputJson,
                '--lang', targetLang,
                '--json'
            ];
            appendStoredTranslationArgs(args);

            const result = await window.api.runBackend(args);

            if (abortRef.current) return null;

            if (result && result.success) {
                setTranslatedSegments(result.segments);
                setStatus('翻译完成');
                return result.segments;
            }

            const errorInfo = normalizeBackendError(result, '字幕翻译失败');
            setStatus('翻译失败');
            setFeedback({
                title: '翻译失败',
                message: buildUserFacingErrorMessage(errorInfo),
                type: 'error'
            });
            return null;
        } catch (e: any) {
            if (abortRef.current || isBackendCanceledError(e)) {
                setStatus('任务已由用户停止');
                return null;
            }
            logUiError('批量翻译失败', {
                domain: 'workflow.translation',
                action: 'handleTranslate',
                detail: e instanceof Error ? e.message : String(e)
            });
            const errorInfo = normalizeBackendError(e, '翻译错误');
            setStatus(buildUserFacingErrorMessage(errorInfo));
            setFeedback({
                title: '翻译错误',
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

    const handleReTranslate = async (index: number) => {
        if (loading || !translatedSegments[index]) return;

        setLoading(true);
        setRetranslatingSegmentId(index);
        setStatus(`正在重新翻译片段 ${index + 1}...`);

        try {
            const sourceText = segments[index].text;
            const args = [
                '--action', 'translate_text',
                '--input', sourceText,
                '--lang', targetLang,
                '--json'
            ];
            appendStoredTranslationArgs(args);

            const result = await window.api.runBackend(args);

            if (result && result.success) {
                const newText = result.text || (result.segments && result.segments[0]?.text);
                if (newText) {
                    setTranslatedSegments(prev => {
                        const next = [...prev];
                        next[index] = { ...next[index], text: newText };
                        return next;
                    });
                    setStatus('重新翻译完成');
                } else {
                    setStatus('重新翻译失败：返回结果为空');
                }
            } else {
                logUiWarn('单段重翻译返回失败结果', {
                    domain: 'workflow.translation',
                    action: 'handleReTranslate',
                    detail: JSON.stringify(result)
                });
                const errorInfo = normalizeBackendError(result, '重新翻译失败');
                setStatus(buildUserFacingErrorMessage(errorInfo));
            }
        } catch (e: any) {
            if (isBackendCanceledError(e)) {
                setStatus('任务已由用户停止');
                return;
            }
            logUiError('单段重翻译异常', {
                domain: 'workflow.translation',
                action: 'handleReTranslate',
                detail: e instanceof Error ? e.message : String(e)
            });
            const errorInfo = normalizeBackendError(e, '重新翻译错误');
            setStatus(buildUserFacingErrorMessage(errorInfo));
        } finally {
            setProgress(0);
            setLoading(false);
            setIsIndeterminate(false);
            setRetranslatingSegmentId(null);
        }
    };

    return {
        handleTranslate,
        handleReTranslate
    };
}
