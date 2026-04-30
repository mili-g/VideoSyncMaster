export const SUPPORTED_ASR_SERVICES = ['bcut', 'jianying', 'faster-whisper', 'funasr', 'qwen', 'vibevoice-asr'] as const;
export const CLOUD_API_ASR_SERVICES = ['bcut', 'jianying'] as const;
export const LOCAL_ASR_SERVICES = ['faster-whisper', 'funasr', 'qwen', 'vibevoice-asr'] as const;

export type AsrService = typeof SUPPORTED_ASR_SERVICES[number];
export const ASR_SOURCE_LANGUAGE_OPTIONS = ['Auto', 'Chinese', 'English', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian'] as const;
export type AsrSourceLanguage = typeof ASR_SOURCE_LANGUAGE_OPTIONS[number];

const ASR_SOURCE_LANGUAGE_LABEL_MAP: Record<AsrSourceLanguage, string> = {
    Auto: 'Auto',
    Chinese: '中文',
    English: 'English',
    Japanese: '日本語',
    Korean: '한국어',
    German: 'Deutsch',
    French: 'Français',
    Russian: 'Русский',
    Portuguese: 'Português',
    Spanish: 'Español',
    Italian: 'Italiano'
};

export interface AsrServiceMeta {
    id: AsrService;
    name: string;
    shortName: string;
    description: string;
    detailTitle: string;
    detailBody: string;
    availability?: 'ready' | 'limited' | 'blocked';
    supportsTimedSubtitles: boolean;
    supportsWorkflowSubtitlePipeline: boolean;
    workflowBlockReason?: string;
    sourceLanguageMode: 'explicit_or_auto' | 'auto_only';
    sourceLanguageDetail: string;
}

export const ASR_SERVICE_META: Record<AsrService, AsrServiceMeta> = {
    'faster-whisper': {
        id: 'faster-whisper',
        name: 'faster-whisper (本地)',
        shortName: 'faster-whisper',
        description: '离线高质量识别，适用于标准字幕生产',
        detailTitle: 'faster-whisper 本地识别',
        detailBody: '面向通用离线转录场景，兼顾识别质量、稳定性与长音频处理能力。',
        supportsTimedSubtitles: true,
        supportsWorkflowSubtitlePipeline: true,
        sourceLanguageMode: 'explicit_or_auto',
        sourceLanguageDetail: '支持自动识别与手动指定语言。多语种素材建议优先使用自动识别。'
    },
    funasr: {
        id: 'funasr',
        name: 'FunASR (本地)',
        shortName: 'FunASR',
        description: '按官方推荐链路组合的中文识别引擎',
        detailTitle: 'FunASR 本地识别',
        detailBody: '使用 paraformer-zh + fsmn-vad + ct-punc 的官方组合，适合中文字幕主流程。',
        availability: 'ready',
        supportsTimedSubtitles: true,
        supportsWorkflowSubtitlePipeline: true,
        sourceLanguageMode: 'explicit_or_auto',
        sourceLanguageDetail: '建议使用 Auto 或中文。当前接入采用中文 FunASR 官方模型组合，非中文素材不建议走该通道。'
    },
    qwen: {
        id: 'qwen',
        name: 'Qwen3 ASR (本地)',
        shortName: 'Qwen3',
        description: '多语种端到端识别引擎',
        detailTitle: 'Qwen3 本地识别',
        detailBody: '面向多语种内容的本地识别方案，适合统一字幕生产流程。',
        availability: 'ready',
        supportsTimedSubtitles: true,
        supportsWorkflowSubtitlePipeline: true,
        sourceLanguageMode: 'explicit_or_auto',
        sourceLanguageDetail: '支持自动识别与手动指定语言，适合多语种内容处理。'
    },
    'vibevoice-asr': {
        id: 'vibevoice-asr',
        name: 'VibeVoice-ASR (本地)',
        shortName: 'VibeVoice-ASR',
        description: '长音频与多说话人识别引擎',
        detailTitle: 'VibeVoice-ASR 本地识别',
        detailBody: '适用于长时音频、多语种素材和多说话人内容识别。',
        availability: 'ready',
        supportsTimedSubtitles: true,
        supportsWorkflowSubtitlePipeline: true,
        sourceLanguageMode: 'explicit_or_auto',
        sourceLanguageDetail: '支持自动识别与手动指定语言，适用于长音频与多语种内容。'
    },
    jianying: {
        id: 'jianying',
        name: '剪映 API (云端)',
        shortName: '剪映 API',
        description: '云端自动识别通道',
        detailTitle: '剪映云端接口',
        detailBody: '接入剪映云端识别能力，语言策略由服务端自动判定。',
        availability: 'limited',
        supportsTimedSubtitles: true,
        supportsWorkflowSubtitlePipeline: true,
        sourceLanguageMode: 'auto_only',
        sourceLanguageDetail: '当前仅支持自动识别。需要手动指定语言时，请切换至本地多语种引擎。'
    },
    bcut: {
        id: 'bcut',
        name: '必剪 API (云端)',
        shortName: '必剪 API',
        description: '云端自动识别通道',
        detailTitle: '必剪云端接口',
        detailBody: '接入必剪云端识别能力，语言策略由服务端自动判定。',
        availability: 'limited',
        supportsTimedSubtitles: true,
        supportsWorkflowSubtitlePipeline: true,
        sourceLanguageMode: 'auto_only',
        sourceLanguageDetail: '当前仅支持自动识别。需要手动指定语言时，请切换至本地多语种引擎。'
    }
};

export function isSupportedAsrService(value: string | null | undefined): value is AsrService {
    return !!value && (SUPPORTED_ASR_SERVICES as readonly string[]).includes(value);
}

export function isCloudApiAsrService(service: AsrService): boolean {
    return (CLOUD_API_ASR_SERVICES as readonly string[]).includes(service);
}

export function isLocalAsrService(service: AsrService): boolean {
    return (LOCAL_ASR_SERVICES as readonly string[]).includes(service);
}

export function isSupportedAsrSourceLanguage(value: string | null | undefined): value is AsrSourceLanguage {
    return !!value && (ASR_SOURCE_LANGUAGE_OPTIONS as readonly string[]).includes(value);
}

export function normalizeAsrSourceLanguage(value: string | null | undefined): AsrSourceLanguage {
    return isSupportedAsrSourceLanguage(value) ? value : 'Auto';
}

export function getAsrServiceLabel(value: string | null | undefined): string {
    if (value && isSupportedAsrService(value)) {
        return ASR_SERVICE_META[value].shortName;
    }
    return 'faster-whisper';
}

export function getAsrWorkflowBlockReason(service: AsrService): string | null {
    const meta = ASR_SERVICE_META[service];
    if (meta.supportsWorkflowSubtitlePipeline) {
        return null;
    }
    return meta.workflowBlockReason || '当前识别引擎不可用于字幕主流程。';
}

export function getAsrSourceLanguageConstraint(
    service: AsrService,
    sourceLanguage: string | null | undefined
): string | null {
    const { meta, normalizedLanguage } = resolveAsrSourceLanguagePolicy(service, sourceLanguage);
    if (service === 'funasr' && !['Auto', 'Chinese'].includes(normalizedLanguage)) {
        return 'FunASR 当前接入的是中文官方模型组合，仅建议使用 Auto 或 中文。请切换为 Auto / 中文，或改用支持多语种的本地引擎。';
    }
    if (meta.sourceLanguageMode === 'auto_only' && normalizedLanguage !== 'Auto') {
        return `${meta.shortName} 当前仅支持自动识别，无法按“${normalizedLanguage}”执行源语言指定。请切换为自动识别，或改用支持语言指定的本地引擎。`;
    }
    return null;
}

export function resolveEffectiveAsrSourceLanguage(
    service: AsrService,
    sourceLanguage: string | null | undefined
): string | undefined {
    const { meta, normalizedLanguage } = resolveAsrSourceLanguagePolicy(service, sourceLanguage);
    if (meta.sourceLanguageMode === 'auto_only') {
        return undefined;
    }
    if (service === 'funasr' && normalizedLanguage === 'Chinese') {
        return 'Chinese';
    }
    if (service === 'funasr') {
        return undefined;
    }
    if (normalizedLanguage === 'Auto') {
        return undefined;
    }
    return normalizedLanguage;
}

export function getAsrSourceLanguageHint(service: AsrService): string {
    return ASR_SERVICE_META[service].sourceLanguageDetail;
}

export function getAsrSourceLanguageLabel(language: AsrSourceLanguage): string {
    return ASR_SOURCE_LANGUAGE_LABEL_MAP[language];
}

function resolveAsrSourceLanguagePolicy(
    service: AsrService,
    sourceLanguage: string | null | undefined
) {
    return {
        meta: ASR_SERVICE_META[service],
        normalizedLanguage: normalizeAsrSourceLanguage(sourceLanguage)
    };
}
