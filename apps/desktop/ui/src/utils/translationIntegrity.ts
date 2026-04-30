import type { SrtSegment } from './srt';

function normalizeComparableText(text: string) {
    return String(text || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

export function assertTranslatedSegmentsDifferFromSource(
    sourceSegments: Array<Pick<SrtSegment, 'text'>>,
    translatedSegments: Array<Pick<SrtSegment, 'text'>>
) {
    if (sourceSegments.length === 0 || translatedSegments.length === 0) {
        return;
    }

    const comparableCount = Math.min(sourceSegments.length, translatedSegments.length);
    let identicalCount = 0;
    let nonEmptyCount = 0;

    for (let index = 0; index < comparableCount; index += 1) {
        const sourceText = normalizeComparableText(sourceSegments[index]?.text || '');
        const translatedText = normalizeComparableText(translatedSegments[index]?.text || '');
        if (!sourceText || !translatedText) {
            continue;
        }
        nonEmptyCount += 1;
        if (sourceText === translatedText) {
            identicalCount += 1;
        }
    }

    if (nonEmptyCount < 3) {
        return;
    }

    const identicalRatio = identicalCount / nonEmptyCount;
    if (identicalRatio >= 0.8) {
        throw new Error('翻译结果与原字幕高度一致，当前翻译链路疑似未生效。系统已阻止将原文直接当作译文继续处理。');
    }
}
