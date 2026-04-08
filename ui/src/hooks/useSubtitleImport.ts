import type { Dispatch, SetStateAction } from 'react';
import type { Segment } from './useVideoProject';

const suspiciousMojibakePattern = /[�ÃâÐÏ]/;

interface SubtitleImportOptions {
    originalVideoPath: string;
    setSegments: Dispatch<SetStateAction<Segment[]>>;
    setTranslatedSegments: Dispatch<SetStateAction<Segment[]>>;
    setStatus: Dispatch<SetStateAction<string>>;
}

export function useSubtitleImport({
    originalVideoPath,
    setSegments,
    setTranslatedSegments,
    setStatus
}: SubtitleImportOptions) {
    const parseSRTContent = (text: string): Segment[] => {
        const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const regex = /(\d+)\s*\n\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*\n([\s\S]*?)(?=\n\d+\s*\n\s*\d{2}:\d{2}[:.]|$)/g;
        const newSegments: Segment[] = [];
        let match: RegExpExecArray | null;

        const parseTime = (timestamp: string) => {
            const cleanTimestamp = timestamp.replace(',', '.');
            const [hours, minutes, seconds] = cleanTimestamp.split(':');
            return parseFloat(hours) * 3600 + parseFloat(minutes) * 60 + parseFloat(seconds);
        };

        while ((match = regex.exec(normalizedText)) !== null) {
            const content = match[4].trim();
            if (content) {
                newSegments.push({
                    start: parseTime(match[2]),
                    end: parseTime(match[3]),
                    text: content
                });
            }
        }

        return newSegments;
    };

    const decodeSubtitleFile = async (file: File) => {
        const buffer = await file.arrayBuffer();

        try {
            const utf8Text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
            const utf8Segments = parseSRTContent(utf8Text);

            if (utf8Segments.length > 0 && !suspiciousMojibakePattern.test(utf8Text)) {
                return utf8Segments;
            }
        } catch (error) {
            console.warn('UTF-8 subtitle decode failed, falling back to gb18030:', error);
        }

        const gb18030Text = new TextDecoder('gb18030').decode(buffer);
        const gb18030Segments = parseSRTContent(gb18030Text);

        if (gb18030Segments.length > 0) {
            return gb18030Segments;
        }

        const fallbackUtf8Text = new TextDecoder('utf-8').decode(buffer);
        return parseSRTContent(fallbackUtf8Text);
    };

    const handleSRTUpload = async (file: File) => {
        if (!originalVideoPath) return;

        const newSegments = await decodeSubtitleFile(file);
        if (newSegments.length > 0) {
            setSegments(newSegments);
            setStatus(`已加载外部源字幕（${newSegments.length} 条）`);
        } else {
            setStatus('字幕解析失败：未找到有效字幕片段');
        }
    };

    const handleTargetSRTUpload = async (file: File) => {
        if (!originalVideoPath) return;

        const newSegments = await decodeSubtitleFile(file);
        if (newSegments.length > 0) {
            const preparedSegments = newSegments.map(segment => ({
                ...segment,
                audioStatus: 'none' as const
            }));
            setTranslatedSegments(preparedSegments);
            setStatus(`已加载译文字幕（${newSegments.length} 条）`);
        } else {
            setStatus('译文字幕解析失败：未找到有效字幕片段');
        }
    };

    return {
        parseSRTContent,
        handleSRTUpload,
        handleTargetSRTUpload
    };
}
