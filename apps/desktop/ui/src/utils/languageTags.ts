const LANGUAGE_TAG_MAP: Record<string, string> = {
    auto: 'und',
    none: 'und',
    chinese: 'zh-CN',
    english: 'en',
    japanese: 'ja',
    korean: 'ko',
    german: 'de',
    french: 'fr',
    russian: 'ru',
    portuguese: 'pt',
    spanish: 'es',
    italian: 'it'
};

export interface SubtitleArtifactLanguages {
    sourceLangTag?: string;
    targetLangTag?: string;
}

export interface LanguageOption {
    value: string;
    label: string;
}

export const TARGET_LANGUAGE_OPTIONS: LanguageOption[] = [
    { value: 'Chinese', label: '中文' },
    { value: 'English', label: 'English' },
    { value: 'Japanese', label: '日本語' },
    { value: 'Korean', label: '한국어' },
    { value: 'German', label: 'Deutsch' },
    { value: 'French', label: 'Français' },
    { value: 'Russian', label: 'Русский' },
    { value: 'Portuguese', label: 'Português' },
    { value: 'Spanish', label: 'Español' },
    { value: 'Italian', label: 'Italiano' }
];

function normalizeLanguageKey(value?: string) {
    return String(value || '').trim().toLowerCase();
}

export function resolveLanguageTag(value?: string, fallback = 'und') {
    const normalized = normalizeLanguageKey(value);
    if (!normalized) return fallback;
    return LANGUAGE_TAG_MAP[normalized] || fallback;
}

export function resolveSubtitleArtifactLanguages(sourceLanguage?: string, targetLanguage?: string): SubtitleArtifactLanguages {
    return {
        sourceLangTag: resolveLanguageTag(sourceLanguage, 'und'),
        targetLangTag: resolveLanguageTag(targetLanguage, 'und')
    };
}
