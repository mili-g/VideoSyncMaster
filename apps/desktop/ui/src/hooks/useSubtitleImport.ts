import type { Dispatch, SetStateAction } from 'react';
import type { Segment } from './useVideoProject';
import { validateSubtitleLanguageFit } from '../utils/batchAssets';
import { decodeSubtitleFile, parseSubtitleContent } from '../utils/subtitleFormats';

type FeedbackType = 'success' | 'error';

interface FeedbackPayload {
    title: string;
    message: string;
    type: FeedbackType;
}

interface SubtitleImportOptions {
    originalVideoPath: string;
    asrOriLang: string;
    targetLang: string;
    setSegments: Dispatch<SetStateAction<Segment[]>>;
    setTranslatedSegments: Dispatch<SetStateAction<Segment[]>>;
    setStatus: Dispatch<SetStateAction<string>>;
    setFeedback: Dispatch<SetStateAction<FeedbackPayload | null>>;
    onSourceSubtitleImported?: (segments: Segment[]) => void | Promise<void>;
    onTranslatedSubtitleImported?: (segments: Segment[]) => void | Promise<void>;
}

export function useSubtitleImport({
    originalVideoPath,
    asrOriLang,
    targetLang,
    setSegments,
    setTranslatedSegments,
    setStatus,
    setFeedback,
    onSourceSubtitleImported,
    onTranslatedSubtitleImported
}: SubtitleImportOptions) {
    const parseImportedSubtitleContent = (text: string): Segment[] => {
        return parseSubtitleContent(text).map((segment) => ({
            start: segment.start,
            end: segment.end,
            text: segment.text
        }));
    };

    const decodeImportedSubtitleFile = async (file: File) => {
        const text = await decodeSubtitleFile(file);
        return parseImportedSubtitleContent(text);
    };

    const validateImportedSegments = (
        importedSegments: Segment[],
        expectedLanguage: string,
        mode: 'source' | 'target'
    ) => {
        const text = importedSegments
            .map(segment => String(segment.text || '').trim())
            .filter(Boolean)
            .join(' ');
        const validation = validateSubtitleLanguageFit(text, expectedLanguage, mode);
        if (!validation.ok) {
            setFeedback({
                title: mode === 'source' ? '原字幕语言不匹配' : '翻译字幕语言不匹配',
                message: validation.reason || '当前导入字幕与已配置语言不匹配。',
                type: 'error'
            });
            setStatus(validation.reason || '字幕语言与当前配置不匹配。');
            return false;
        }
        return true;
    };

    const handleSRTUpload = async (file: File) => {
        if (!originalVideoPath) return;

        const newSegments = await decodeImportedSubtitleFile(file);
        if (newSegments.length > 0) {
            if (!validateImportedSegments(newSegments, asrOriLang, 'source')) {
                return;
            }
            setSegments(newSegments);
            await onSourceSubtitleImported?.(newSegments);
            setStatus(`已加载外部原字幕（${newSegments.length} 条）`);
        } else {
            setStatus('字幕解析失败：未找到有效字幕片段');
        }
    };

    const handleTargetSRTUpload = async (file: File) => {
        if (!originalVideoPath) return;

        const newSegments = await decodeImportedSubtitleFile(file);
        if (newSegments.length > 0) {
            if (!validateImportedSegments(newSegments, targetLang, 'target')) {
                return;
            }
            const preparedSegments = newSegments.map(segment => ({
                ...segment,
                audioStatus: 'none' as const
            }));
            setTranslatedSegments(preparedSegments);
            await onTranslatedSubtitleImported?.(preparedSegments);
            setStatus(`已加载译文字幕（${newSegments.length} 条）`);
        } else {
            setStatus('译文字幕解析失败：未找到有效字幕片段');
        }
    };

    return {
        parseSRTContent: parseImportedSubtitleContent,
        handleSRTUpload,
        handleTargetSRTUpload
    };
}
