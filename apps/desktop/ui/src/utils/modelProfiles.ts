import type { AsrService } from './asrService';

export type TtsService = 'indextts' | 'qwen' | 'gptsovits';

export interface ModelProfileOption {
    id: string;
    label: string;
    description: string;
}

export const ASR_MODEL_PROFILES: Record<AsrService, ModelProfileOption[]> = {
    bcut: [
        { id: 'default', label: '云端默认', description: '由服务端自动选择，无需本地模型。' }
    ],
    jianying: [
        { id: 'default', label: '云端默认', description: '由服务端自动选择，无需本地模型。' }
    ],
    funasr: [
        { id: 'standard', label: 'Standard / SenseVoiceSmall', description: '多语言档位，适合中英混合与英文素材。' },
        { id: 'zh', label: 'Chinese / paraformer-zh', description: '中文优先档位，使用 paraformer-zh、fsmn-vad 和 ct-punc。' }
    ],
    'faster-whisper': [
        { id: 'quality', label: 'Quality / large-v3', description: '高质量档位，适用于正式字幕生产。' },
        { id: 'balanced', label: 'Balanced / large-v3-turbo', description: '均衡档位，兼顾处理速度与识别质量。' }
    ],
    qwen: [
        { id: 'standard', label: 'Standard / 1.7B', description: '标准档位，面向多语种正式识别任务。' },
        { id: 'fast', label: 'Fast / 0.6B', description: '轻量档位，适合快速处理与受限设备。' }
    ],
    'vibevoice-asr': [
        { id: 'standard', label: 'Standard / HF', description: '标准档位，适用于长音频与多说话人内容。' }
    ]
};

export const TTS_MODEL_PROFILES: Record<TtsService, ModelProfileOption[]> = {
    indextts: [
        { id: 'standard', label: 'Standard', description: '标准档位，适用于常规语音合成任务。' }
    ],
    gptsovits: [
        { id: 'balanced', label: 'Balanced / 平衡', description: '默认生产档位，兼顾速度、稳定性与完整朗读。' },
        { id: 'fast', label: 'Fast / 极速', description: '优先吞吐与响应速度，自动保持在硬件安全范围内。' },
        { id: 'quality', label: 'Quality / 高保真', description: '优先文本完整度与发音稳定性，适合正式成片。' }
    ],
    qwen: [
        { id: 'quality', label: 'Quality / 1.7B', description: '高质量档位，适用于正式配音生产。' },
        { id: 'fast', label: 'Fast / 0.6B', description: '轻量档位，适合快速试听与资源受限设备。' }
    ]
};

const ASR_PROFILE_STORAGE_KEYS: Record<AsrService, string> = {
    bcut: 'asr_model_profile_bcut',
    jianying: 'asr_model_profile_jianying',
    funasr: 'asr_model_profile_funasr',
    'faster-whisper': 'asr_model_profile_faster_whisper',
    qwen: 'asr_model_profile_qwen',
    'vibevoice-asr': 'asr_model_profile_vibevoice_asr'
};

const TTS_PROFILE_STORAGE_KEYS: Record<TtsService, string> = {
    indextts: 'tts_model_profile_indextts',
    gptsovits: 'tts_model_profile_gptsovits',
    qwen: 'tts_model_profile_qwen'
};

export function getDefaultAsrModelProfile(service: AsrService): string {
    return ASR_MODEL_PROFILES[service][0]?.id || 'default';
}

export function getDefaultTtsModelProfile(service: TtsService): string {
    return TTS_MODEL_PROFILES[service][0]?.id || 'standard';
}

export function getStoredAsrModelProfile(service: AsrService): string {
    const saved = localStorage.getItem(ASR_PROFILE_STORAGE_KEYS[service]);
    const options = ASR_MODEL_PROFILES[service];
    if (saved && options.some(option => option.id === saved)) {
        return saved;
    }
    return getDefaultAsrModelProfile(service);
}

export function setStoredAsrModelProfile(service: AsrService, profileId: string) {
    localStorage.setItem(ASR_PROFILE_STORAGE_KEYS[service], profileId);
}

export function getStoredTtsModelProfile(service: TtsService): string {
    const saved = localStorage.getItem(TTS_PROFILE_STORAGE_KEYS[service]);
    const options = TTS_MODEL_PROFILES[service];
    if (saved && options.some(option => option.id === saved)) {
        return saved;
    }
    return getDefaultTtsModelProfile(service);
}

export function setStoredTtsModelProfile(service: TtsService, profileId: string) {
    localStorage.setItem(TTS_PROFILE_STORAGE_KEYS[service], profileId);
    if (service === 'qwen') {
        localStorage.setItem('qwen_tts_model', profileId === 'fast' ? '0.6B' : '1.7B');
    }
}
