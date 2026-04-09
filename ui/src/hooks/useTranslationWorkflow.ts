import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Segment } from './useVideoProject';
import { isBackendCanceledError } from '../utils/backendCancellation';

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
            const transApiKey = localStorage.getItem('trans_api_key') || '';
            const transApiBaseUrl = localStorage.getItem('trans_api_base_url') || '';
            const transApiModel = localStorage.getItem('trans_api_model') || '';
            const args = [
                '--action', 'translate_text',
                '--input', inputJson,
                '--lang', targetLang,
                '--json'
            ];

            if (transApiKey) {
                args.push('--api_key', transApiKey);
                if (transApiBaseUrl) args.push('--base_url', transApiBaseUrl);
                if (transApiModel) args.push('--model', transApiModel);
            }

            const result = await window.api.runBackend(args);

            if (abortRef.current) return null;

            if (result && result.success) {
                setTranslatedSegments(result.segments);
                setStatus('翻译完成');
                return result.segments;
            }

            setStatus('翻译失败');
            setFeedback({
                title: '翻译失败',
                message: `API 返回错误：\n${result?.error || '未知错误'}`,
                type: 'error'
            });
            return null;
        } catch (e: any) {
            if (abortRef.current || isBackendCanceledError(e)) {
                setStatus('任务已由用户停止');
                return null;
            }
            console.error(e);
            setStatus(`翻译错误: ${e.message}`);
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
            const transApiKey = localStorage.getItem('trans_api_key') || '';
            const transApiBaseUrl = localStorage.getItem('trans_api_base_url') || '';
            const transApiModel = localStorage.getItem('trans_api_model') || '';
            const args = [
                '--action', 'translate_text',
                '--input', sourceText,
                '--lang', targetLang,
                '--json'
            ];

            if (transApiKey) {
                args.push('--api_key', transApiKey);
                if (transApiBaseUrl) args.push('--base_url', transApiBaseUrl);
                if (transApiModel) args.push('--model', transApiModel);
            }

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
                console.error('Re-translation failed:', result);
                setStatus(`重新翻译失败: ${result?.error || '未知错误'}`);
            }
        } catch (e: any) {
            if (isBackendCanceledError(e)) {
                setStatus('任务已由用户停止');
                return;
            }
            console.error(e);
            setStatus(`重新翻译错误: ${e.message}`);
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
