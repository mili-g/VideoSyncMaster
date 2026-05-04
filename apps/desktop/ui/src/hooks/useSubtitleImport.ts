import type { Dispatch, SetStateAction } from 'react';
import type { Segment } from './useVideoProject';
import { validateSubtitleLanguageFit } from '../utils/batchAssets';
import { decodeSubtitleFile, parseSubtitleContent } from '../utils/subtitleFormats';

interface SubtitleImportOptions {
    originalVideoPath: string;
    asrOriLang: string;
    targetLang: string;
    setSegments: Dispatch<SetStateAction<Segment[]>>;
    setTranslatedSegments: Dispatch<SetStateAction<Segment[]>>;
    setStatus: Dispatch<SetStateAction<string>>;
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
        return validation;
    };

    const handleSRTUpload = async (file: File) => {
        if (!originalVideoPath) return;

        const newSegments = await decodeImportedSubtitleFile(file);
        if (newSegments.length > 0) {
            const validation = validateImportedSegments(newSegments, asrOriLang, 'source');
            if (!validation.ok) {
                setStatus(`已加载外部原字幕（${newSegments.length} 条），但语言校验未通过，请确认源语言设置。`);
            }
            setSegments(newSegments);
            await onSourceSubtitleImported?.(newSegments);
            if (validation.ok) {
                setStatus(`已加载外部原字幕（${newSegments.length} 条）`);
            }
        } else {
            setStatus('字幕解析失败：未找到有效字幕片段');
        }
    };

    const handleTargetSRTUpload = async (file: File) => {
        if (!originalVideoPath) return;

        const newSegments = await decodeImportedSubtitleFile(file);
        if (newSegments.length > 0) {
            const validation = validateImportedSegments(newSegments, targetLang, 'target');
            if (!validation.ok) {
                setStatus(`已加载译文字幕（${newSegments.length} 条），但语言校验未通过，请确认目标语言设置。`);
            }
            const preparedSegments = newSegments.map(segment => ({
                ...segment,
                audioStatus: 'none' as const
            }));
            setTranslatedSegments(preparedSegments);
            await onTranslatedSubtitleImported?.(preparedSegments);
            if (validation.ok) {
                setStatus(`已加载译文字幕（${newSegments.length} 条）`);
            }
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
