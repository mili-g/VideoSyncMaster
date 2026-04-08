export type BatchAssetKind = 'video' | 'subtitle-original' | 'subtitle-translated' | 'unknown';

export interface BatchInputAsset {
    path: string;
    name: string;
    textContent?: string;
}

const TRANSLATED_MARKERS = [
    'translated',
    'translation',
    'target',
    '译',
    '译文',
    '翻译',
    '中文',
    '汉化',
    'zh',
    'cn',
    'chs',
    'cht'
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
    'cn',
    'zh',
    'chs',
    'cht',
    'english',
    'chinese',
    '中文字幕',
    '原字幕',
    '翻译字幕',
    '译文字幕',
    '配音字幕'
];

export function classifyBatchAsset(asset: BatchInputAsset): BatchAssetKind {
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
    const base = fileName.replace(/\.[^/.]+$/, '').toLowerCase();
    const normalized = base
        .replace(/[._()[\]{}\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const words = normalized
        .split(' ')
        .filter(Boolean)
        .filter(word => !STRIP_MARKERS.includes(word));

    return words.join(' ').trim() || normalized;
}

export function isTranslatedSubtitleName(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    return TRANSLATED_MARKERS.some(marker => lower.includes(marker));
}
