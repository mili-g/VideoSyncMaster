export type BatchAssetKind = 'video' | 'subtitle-original' | 'subtitle-translated' | 'unknown';

export interface BatchInputAsset {
    path: string;
    name: string;
    textContent?: string;
    kindOverride?: Extract<BatchAssetKind, 'subtitle-original' | 'subtitle-translated'>;
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
        return isTranslatedSubtitleName(asset.name) ? 'subtitle-translated' : 'subtitle-original';
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

    if (tokens.some(token => ORIGINAL_MARKERS.includes(token))) {
        return false;
    }

    return false;
}

function normalizeAssetStem(fileName: string) {
    return fileName
        .replace(/\.[^/.]+$/, '')
        .toLowerCase()
        .replace(/[._()[\]{}\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getAssetNameTokens(fileName: string) {
    return normalizeAssetStem(fileName)
        .split(' ')
        .filter(Boolean);
}
