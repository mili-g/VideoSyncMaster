import type { Dispatch, MouseEvent, MutableRefObject, SetStateAction } from 'react';
import type { Segment } from './useVideoProject';
import { isBackendCanceledError } from '../utils/backendCancellation';
import { buildUserFacingErrorMessage, normalizeBackendError } from '../utils/backendErrors';
import { logUiError, logUiWarn } from '../utils/frontendLogger';
import { buildTranslateTextCommand } from '../utils/backendCommandBuilders';
import { runBackendCommand } from '../utils/backendCommandClient';
import { appendStoredTranslationArgs } from '../utils/runtimeSettings';
import { validateSegmentLanguageFit } from '../utils/subtitleLanguageGuard';
import { assertTranslatedSegmentsDifferFromSource } from '../utils/translationIntegrity';

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
    asrOriLang: string;
    loading: boolean;
    abortRef: MutableRefObject<boolean>;
    setLoading: Dispatch<SetStateAction<boolean>>;
    setIsIndeterminate: Dispatch<SetStateAction<boolean>>;
    setProgress: Dispatch<SetStateAction<number>>;
    setStatus: Dispatch<SetStateAction<string>>;
    setTranslatedSegments: Dispatch<SetStateAction<Segment[]>>;
    setFeedback: Dispatch<SetStateAction<FeedbackPayload | null>>;
    setRetranslatingSegmentId: Dispatch<SetStateAction<number | null>>;
    setBusyTask: Dispatch<SetStateAction<'asr' | 'translation' | 'merge' | null>>;
    onTranslatedSegmentsCommitted?: (segments: Segment[]) => void | Promise<void>;
}

export function useTranslationWorkflow({
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
    onTranslatedSegmentsCommitted
}: TranslationWorkflowOptions) {
    const handleTranslate = async (overrideSegments?: Segment[] | MouseEvent<HTMLElement>): Promise<Segment[] | null> => {
        const segsToUse = Array.isArray(overrideSegments) ? overrideSegments : segments;
        if (segsToUse.length === 0) return null;
        const previousTranslatedSegments = translatedSegments;

        setBusyTask('translation');
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
            const command = buildTranslateTextCommand({
                input: inputJson,
                targetLang,
                json: true
            });
            appendStoredTranslationArgs(command.args);

            const result = await runBackendCommand(command);

            if (abortRef.current) return null;

            if (result && result.success) {
                const translatedSegments = result.segments || [];
                const sourceValidation = validateSegmentLanguageFit(segsToUse, asrOriLang, 'source');
                if (!sourceValidation.ok) {
                    setTranslatedSegments(previousTranslatedSegments);
                    setStatus(sourceValidation.reason || '原字幕语言与当前配置不匹配。');
                    setFeedback({
                        title: '原字幕语言不匹配',
                        message: sourceValidation.reason || '原字幕语言与当前配置不匹配。',
                        type: 'error'
                    });
                    return null;
                }
                const translatedValidation = validateSegmentLanguageFit(translatedSegments, targetLang, 'target');
                if (!translatedValidation.ok) {
                    setTranslatedSegments(previousTranslatedSegments);
                    setStatus(translatedValidation.reason || '翻译字幕语言与当前配置不匹配。');
                    setFeedback({
                        title: '翻译结果语言不匹配',
                        message: translatedValidation.reason || '翻译字幕语言与当前配置不匹配。',
                        type: 'error'
                    });
                    return null;
                }
                assertTranslatedSegmentsDifferFromSource(segsToUse, translatedSegments);
                setTranslatedSegments(translatedSegments);
                await onTranslatedSegmentsCommitted?.(translatedSegments);
                setStatus('翻译完成');
                return translatedSegments;
            }

            const errorInfo = normalizeBackendError(result, '字幕翻译失败');
            setTranslatedSegments(previousTranslatedSegments);
            setStatus('翻译失败');
            setFeedback({
                title: '翻译失败',
                message: buildUserFacingErrorMessage(errorInfo),
                type: 'error'
            });
            return null;
        } catch (e: unknown) {
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
            setTranslatedSegments(previousTranslatedSegments);
            setStatus(buildUserFacingErrorMessage(errorInfo));
            setFeedback({
                title: '翻译错误',
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

    const handleReTranslate = async (index: number) => {
        if (loading || !translatedSegments[index]) return;

        setBusyTask('translation');
        setLoading(true);
        setRetranslatingSegmentId(index);
        setStatus(`正在重新翻译片段 ${index + 1}...`);

        try {
            const sourceText = segments[index].text;
            const command = buildTranslateTextCommand({
                input: sourceText,
                targetLang,
                json: true
            });
            appendStoredTranslationArgs(command.args);

            const result = await runBackendCommand(command);

            if (result && result.success) {
                const newText = result.text || (result.segments && result.segments[0]?.text);
                if (newText) {
                    const nextSegments = translatedSegments.map((segment, segmentIndex) => (
                        segmentIndex === index ? { ...segment, text: newText } : segment
                    ));
                    const translatedValidation = validateSegmentLanguageFit(nextSegments, targetLang, 'target');
                    if (!translatedValidation.ok) {
                        setStatus(translatedValidation.reason || '翻译字幕语言与当前配置不匹配。');
                        setFeedback({
                            title: '翻译结果语言不匹配',
                            message: translatedValidation.reason || '翻译字幕语言与当前配置不匹配。',
                            type: 'error'
                        });
                        return;
                    }
                    assertTranslatedSegmentsDifferFromSource(segments, nextSegments);
                    setTranslatedSegments(prev => {
                        const next = [...prev];
                        next[index] = { ...next[index], text: newText };
                        return next;
                    });
                    await onTranslatedSegmentsCommitted?.(nextSegments);
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
        } catch (e: unknown) {
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
            setBusyTask(null);
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
