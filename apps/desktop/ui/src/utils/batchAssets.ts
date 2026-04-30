export type BatchAssetKind = 'video' | 'subtitle-original' | 'subtitle-translated' | 'unknown';

export interface BatchInputAsset {
    path: string;
    name: string;
    textContent?: string;
    kindOverride?: Extract<BatchAssetKind, 'subtitle-original' | 'subtitle-translated'>;
    suggestedItemId?: string;
    requiresManualAssignment?: boolean;
}

export interface SubtitleAssignmentHint {
    suggestedKind?: Extract<BatchAssetKind, 'subtitle-original' | 'subtitle-translated'>;
    reason?: string;
}

export interface SubtitleLanguageValidationResult {
    ok: boolean;
    observedFamily: string;
    reason?: string;
}

const TRANSLATED_MARKERS = [
    'zh',
    'cn',
    'chs',
    'cht',
    'chinese',
    '中文',
    '中文字幕',
    'translated',
    'translation',
    'target',
    '译',
    '译文',
    '翻译'
];

const ORIGINAL_MARKERS = [
    'original',
    'source',
    'orig',
    'src',
    'en',
    'eng',
    'english',
    '英文',
    '原字幕',
    '英文字幕'
];

const STRIP_MARKERS = [
    'subtitle',
    'subtitles',
    'subs',
    'sub',
    'caption',
    'captions',
    'srt',
    'original',
    'source',
    'translated',
    'translation',
    'target',
    'orig',
    'src',
    'en',
    'eng',
    'cn',
    'zh',
    'chs',
    'cht',
    'english',
    '英文',
    'chinese',
    '中文字幕',
    '原字幕',
    '翻译字幕',
    '译文字幕',
    '配音字幕'
];

export function classifyBatchAsset(asset: BatchInputAsset): BatchAssetKind {
    if (asset.kindOverride) {
        return asset.kindOverride;
    }

    const lower = asset.name.toLowerCase();
    if (/\.(mp4|mov|mkv|avi|webm|mp3|wav|m4a)$/i.test(lower)) {
        return 'video';
    }

    if (/\.srt$/i.test(lower)) {
        if (isTranslatedSubtitleName(asset.name)) {
            return 'subtitle-translated';
        }
        if (isOriginalSubtitleName(asset.name)) {
            return 'subtitle-original';
        }
        return 'unknown';
    }

    return 'unknown';
}

export function buildBatchMatchKey(fileName: string): string {
    const normalized = normalizeAssetStem(fileName);

    const words = normalized
        .split(' ')
        .filter(Boolean)
        .filter(word => !STRIP_MARKERS.includes(word));

    return words.join(' ').trim() || normalized;
}

export function isTranslatedSubtitleName(fileName: string): boolean {
    const tokens = getAssetNameTokens(fileName);
    if (tokens.some(token => TRANSLATED_MARKERS.includes(token))) {
        return true;
    }
    return false;
}

export function isOriginalSubtitleName(fileName: string): boolean {
    const tokens = getAssetNameTokens(fileName);
    return tokens.some(token => ORIGINAL_MARKERS.includes(token));
}

function normalizeAssetStem(fileName: string) {
    return fileName
        .replace(/\.[^/.]+$/, '')
        .toLowerCase()
        .replace(/[._()[\]{}-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getAssetNameTokens(fileName: string) {
    return normalizeAssetStem(fileName)
        .split(' ')
        .filter(Boolean);
}

function resolveTargetScriptFamily(targetLang: string) {
    switch (String(targetLang || '').trim().toLowerCase()) {
        case 'chinese':
            return 'han';
        case 'japanese':
            return 'ja';
        case 'korean':
            return 'ko';
        case 'english':
        case 'german':
        case 'french':
        case 'portuguese':
        case 'spanish':
        case 'italian':
            return 'latin';
        case 'russian':
            return 'cyrillic';
        case 'auto':
        case 'none':
            return 'unknown';
        default:
            return 'unknown';
    }
}

function countScriptUsage(text: string) {
    const counts = {
        han: 0,
        kana: 0,
        hangul: 0,
        latin: 0,
        cyrillic: 0
    };

    for (const char of text) {
        const code = char.charCodeAt(0);
        if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
            counts.han += 1;
        } else if ((code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff)) {
            counts.kana += 1;
        } else if (code >= 0xac00 && code <= 0xd7af) {
            counts.hangul += 1;
        } else if ((code >= 0x0400 && code <= 0x04ff) || (code >= 0x0500 && code <= 0x052f)) {
            counts.cyrillic += 1;
        } else if ((code >= 0x0041 && code <= 0x005a) || (code >= 0x0061 && code <= 0x007a)) {
            counts.latin += 1;
        }
    }

    return counts;
}

function resolveDominantScriptFamily(counts: ReturnType<typeof countScriptUsage>) {
    const orderedEntries = Object.entries(counts).sort((left, right) => right[1] - left[1]);
    const [family, count] = orderedEntries[0] || ['unknown', 0];
    return count > 0 ? family : 'unknown';
}

function normalizeSubtitleValidationText(text: string) {
    return String(text || '')
        .replace(/^\s*\d+\s*$/gm, ' ')
        .replace(/\d{2}:\d{2}:\d{2}[,.:]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.:]\d{3}/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\{[^}]+\}/g, ' ')
        .replace(/\[[^\]]+\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isScriptFamilyCompatible(expectedFamily: string, counts: ReturnType<typeof countScriptUsage>) {
    switch (expectedFamily) {
        case 'han':
            return counts.han >= 12 && counts.han >= counts.latin && counts.han >= counts.hangul;
        case 'ja':
            return counts.kana >= 8 || (counts.kana >= 4 && counts.han >= 8);
        case 'ko':
            return counts.hangul >= 8 && counts.hangul >= counts.han && counts.hangul >= counts.latin;
        case 'latin':
            return counts.latin >= 20 && counts.latin > (counts.han + counts.kana + counts.hangul + counts.cyrillic);
        case 'cyrillic':
            return counts.cyrillic >= 12 && counts.cyrillic > (counts.han + counts.kana + counts.hangul + counts.latin);
        default:
            return true;
    }
}

function getLanguageDisplayName(language: string) {
    switch (String(language || '').trim().toLowerCase()) {
        case 'chinese':
            return '中文';
        case 'english':
            return '英文';
        case 'japanese':
            return '日文';
        case 'korean':
            return '韩文';
        case 'german':
            return '德文';
        case 'french':
            return '法文';
        case 'russian':
            return '俄文';
        case 'portuguese':
            return '葡萄牙文';
        case 'spanish':
            return '西班牙文';
        case 'italian':
            return '意大利文';
        case 'auto':
            return '自动识别';
        default:
            return language || '当前语言';
    }
}

export function validateSubtitleLanguageFit(
    text: string,
    expectedLanguage: string,
    mode: 'source' | 'target'
): SubtitleLanguageValidationResult {
    const expectedFamily = resolveTargetScriptFamily(expectedLanguage);
    const normalizedText = normalizeSubtitleValidationText(text).slice(0, 4000);

    if (!normalizedText) {
        return {
            ok: false,
            observedFamily: 'unknown',
            reason: '字幕内容为空，无法确认语言是否匹配。'
        };
    }

    if (expectedFamily === 'unknown') {
        return {
            ok: true,
            observedFamily: resolveDominantScriptFamily(countScriptUsage(normalizedText))
        };
    }

    const counts = countScriptUsage(normalizedText);
    const observedFamily = resolveDominantScriptFamily(counts);
    if (isScriptFamilyCompatible(expectedFamily, counts)) {
        return {
            ok: true,
            observedFamily
        };
    }

    const scopeLabel = mode === 'source' ? '原字幕' : '翻译字幕';
    const languageLabel = getLanguageDisplayName(expectedLanguage);
    return {
        ok: false,
        observedFamily,
        reason: `当前${scopeLabel}与已配置的${languageLabel}不匹配，不能继续按该字幕类型处理。`
    };
}

export function getSubtitleAssignmentHint(
    asset: Pick<BatchInputAsset, 'name' | 'textContent'>,
    sourceLang: string,
    targetLang: string
): SubtitleAssignmentHint {
    if (isTranslatedSubtitleName(asset.name)) {
        return {
            suggestedKind: 'subtitle-translated',
            reason: '文件名明确包含翻译字幕标记'
        };
    }

    if (isOriginalSubtitleName(asset.name)) {
        return {
            suggestedKind: 'subtitle-original',
            reason: '文件名明确包含原字幕标记'
        };
    }

    const text = String(asset.textContent || '').replace(/\s+/g, '');
    if (!text) {
        return {
            reason: '文件名和内容都不足以判断字幕用途'
        };
    }

    const counts = countScriptUsage(text.slice(0, 4000));
    const sourceFamily = resolveTargetScriptFamily(sourceLang);
    const targetFamily = resolveTargetScriptFamily(targetLang);

    if (sourceFamily === 'han' && counts.han >= 12 && counts.han > counts.latin * 2) {
        return {
            suggestedKind: 'subtitle-original',
            reason: '内容主体接近当前源语言中文'
        };
    }
    if (sourceFamily === 'ja' && counts.kana >= 8) {
        return {
            suggestedKind: 'subtitle-original',
            reason: '内容主体接近当前源语言日文'
        };
    }
    if (sourceFamily === 'ko' && counts.hangul >= 8) {
        return {
            suggestedKind: 'subtitle-original',
            reason: '内容主体接近当前源语言韩文'
        };
    }
    if (sourceFamily === 'latin' && counts.latin >= 20 && counts.latin > (counts.han + counts.kana + counts.hangul) * 2) {
        return {
            suggestedKind: 'subtitle-original',
            reason: '内容主体接近当前源语言的拉丁字母文本'
        };
    }
    if (sourceFamily === 'cyrillic' && counts.cyrillic >= 12) {
        return {
            suggestedKind: 'subtitle-original',
            reason: '内容主体接近当前源语言的西里尔字母文本'
        };
    }

    if (targetFamily === 'han' && counts.han >= 12 && counts.han > counts.latin * 2) {
        return {
            suggestedKind: 'subtitle-translated',
            reason: '内容主体接近当前目标语言中文'
        };
    }
    if (targetFamily === 'ja' && counts.kana >= 8) {
        return {
            suggestedKind: 'subtitle-translated',
            reason: '内容主体接近当前目标语言日文'
        };
    }
    if (targetFamily === 'ko' && counts.hangul >= 8) {
        return {
            suggestedKind: 'subtitle-translated',
            reason: '内容主体接近当前目标语言韩文'
        };
    }
    if (targetFamily === 'latin' && counts.latin >= 20 && counts.latin > (counts.han + counts.kana + counts.hangul + counts.cyrillic) * 2) {
        return {
            suggestedKind: 'subtitle-translated',
            reason: '内容主体接近当前目标语言的拉丁字母文本'
        };
    }
    if (targetFamily === 'cyrillic' && counts.cyrillic >= 12) {
        return {
            suggestedKind: 'subtitle-translated',
            reason: '内容主体接近当前目标语言的西里尔字母文本'
        };
    }

    return {
        reason: '建议人工确认字幕用途'
    };
}
