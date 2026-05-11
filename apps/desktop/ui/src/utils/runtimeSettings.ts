import { getStoredTtsModelProfile } from './modelProfiles';

export interface TranslationApiSettings {
    apiKey: string;
    baseUrl: string;
    model: string;
}

export interface WhisperVadSettings {
    onset: string;
    offset: string;
}

export type LocalAsrDevice = 'auto' | 'cuda' | 'cpu';

export interface AsrRuntimeSettings {
    whisperVadOnset: number;
    whisperVadOffset: number;
    fasterWhisperVadFilter: boolean;
    fasterWhisperVadThreshold: number;
    funAsrBatchSizeSeconds: number;
    funAsrMergeVad: boolean;
    localAsrDevice: LocalAsrDevice;
    localAsrMaxInferenceBatchSize: number;
    localAsrMaxNewTokens: number;
}

export interface QwenTtsSettings {
    mode: 'clone' | 'design' | 'preset';
    modelSize: string;
    presetVoice: string;
    voiceInstruction: string;
    designRefAudio: string;
    refAudio: string;
    refText: string;
}

export interface GptSovitsTtsSettings {
    refAudio: string;
    promptText: string;
    textSplitMethod: 'cut0' | 'cut1' | 'cut2' | 'cut3' | 'cut4' | 'cut5';
    speedFactor: number;
    batchThreshold: number;
    parallelInfer: boolean;
    sampleSteps: number;
    officialFastMode: boolean;
}

export type TtsVoiceMode = 'clone' | 'narration';
export const GPT_SOVITS_BUILTIN_VOICE_JING_YUAN = 'builtin://gpt-sovits/jing-yuan-cn';
export const GPT_SOVITS_BUILTIN_VOICE_KAFKA = 'builtin://gpt-sovits/kafka-cn';
export const GPT_SOVITS_BUILTIN_PROMPT_JING_YUAN = '我是「罗浮」云骑将军景元。不必拘谨，「将军」只是一时的身份，你称呼我景元便可。';
export const GPT_SOVITS_BUILTIN_PROMPT_KAFKA = '嗨，列车团…嗯，你们逮住我啦。';
export const GPT_SOVITS_PROFILE_DEFAULTS: Record<'fast' | 'balanced' | 'quality', Omit<GptSovitsTtsSettings, 'refAudio' | 'promptText'>> = {
    fast: {
        textSplitMethod: 'cut0',
        speedFactor: 1.0,
        batchThreshold: 1.2,
        parallelInfer: true,
        sampleSteps: 28,
        officialFastMode: true
    },
    balanced: {
        textSplitMethod: 'cut0',
        speedFactor: 1.0,
        batchThreshold: 0.68,
        parallelInfer: true,
        sampleSteps: 32,
        officialFastMode: false
    },
    quality: {
        textSplitMethod: 'cut5',
        speedFactor: 1.0,
        batchThreshold: 0.42,
        parallelInfer: false,
        sampleSteps: 44,
        officialFastMode: false
    }
};

const ASR_RUNTIME_STORAGE_KEYS = {
    whisperVadOnset: 'whisper_vad_onset',
    whisperVadOffset: 'whisper_vad_offset',
    fasterWhisperVadFilter: 'faster_whisper_vad_filter',
    fasterWhisperVadThreshold: 'faster_whisper_vad_threshold',
    funAsrBatchSizeSeconds: 'funasr_batch_size_s',
    funAsrMergeVad: 'funasr_merge_vad',
    localAsrDevice: 'local_asr_device',
    localAsrMaxInferenceBatchSize: 'local_asr_max_inference_batch_size',
    localAsrMaxNewTokens: 'local_asr_max_new_tokens'
} as const;

export const DEFAULT_ASR_RUNTIME_SETTINGS: AsrRuntimeSettings = {
    whisperVadOnset: 0.7,
    whisperVadOffset: 0.7,
    fasterWhisperVadFilter: true,
    fasterWhisperVadThreshold: 0.4,
    funAsrBatchSizeSeconds: 300,
    funAsrMergeVad: true,
    localAsrDevice: 'auto',
    localAsrMaxInferenceBatchSize: 32,
    localAsrMaxNewTokens: 256
};

function parseNumberSetting(value: string | null, fallback: number): number {
    const parsed = Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIntegerSetting(value: string | null, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function getStoredTranslationApiSettings(): TranslationApiSettings {
    return {
        apiKey: localStorage.getItem('trans_api_key') || '',
        baseUrl: localStorage.getItem('trans_api_base_url') || '',
        model: localStorage.getItem('trans_api_model') || ''
    };
}

export function isTranslationApiSettingsComplete(settings: TranslationApiSettings) {
    return Boolean(settings.apiKey.trim() && settings.baseUrl.trim() && settings.model.trim());
}

function resolveArgList(target: string[] | { args?: string[] }): string[] {
    if (Array.isArray(target)) {
        return target;
    }
    if (target && Array.isArray(target.args)) {
        return target.args;
    }
    throw new TypeError('Backend argument list is invalid');
}

export function appendStoredTranslationArgs(args: string[] | { args?: string[] }) {
    const argList = resolveArgList(args);
    const settings = getStoredTranslationApiSettings();
    if (!isTranslationApiSettingsComplete(settings)) {
        return settings;
    }

    argList.push('--api_key', settings.apiKey);
    argList.push('--base_url', settings.baseUrl);
    argList.push('--model', settings.model);
    return settings;
}

export function getStoredWhisperVadSettings(): WhisperVadSettings {
    const settings = getStoredAsrRuntimeSettings();
    return {
        onset: settings.whisperVadOnset.toFixed(3),
        offset: settings.whisperVadOffset.toFixed(3)
    };
}

export function getStoredAsrRuntimeSettings(): AsrRuntimeSettings {
    const localAsrDevice = localStorage.getItem(ASR_RUNTIME_STORAGE_KEYS.localAsrDevice) || localStorage.getItem('qwen_asr_device');
    return {
        whisperVadOnset: parseNumberSetting(localStorage.getItem(ASR_RUNTIME_STORAGE_KEYS.whisperVadOnset), DEFAULT_ASR_RUNTIME_SETTINGS.whisperVadOnset),
        whisperVadOffset: parseNumberSetting(localStorage.getItem(ASR_RUNTIME_STORAGE_KEYS.whisperVadOffset), DEFAULT_ASR_RUNTIME_SETTINGS.whisperVadOffset),
        fasterWhisperVadFilter: localStorage.getItem(ASR_RUNTIME_STORAGE_KEYS.fasterWhisperVadFilter) !== 'false',
        fasterWhisperVadThreshold: parseNumberSetting(localStorage.getItem(ASR_RUNTIME_STORAGE_KEYS.fasterWhisperVadThreshold), DEFAULT_ASR_RUNTIME_SETTINGS.fasterWhisperVadThreshold),
        funAsrBatchSizeSeconds: Math.max(1, parseIntegerSetting(localStorage.getItem(ASR_RUNTIME_STORAGE_KEYS.funAsrBatchSizeSeconds), DEFAULT_ASR_RUNTIME_SETTINGS.funAsrBatchSizeSeconds)),
        funAsrMergeVad: localStorage.getItem(ASR_RUNTIME_STORAGE_KEYS.funAsrMergeVad) !== 'false',
        localAsrDevice: localAsrDevice === 'cuda' || localAsrDevice === 'cpu' ? localAsrDevice : DEFAULT_ASR_RUNTIME_SETTINGS.localAsrDevice,
        localAsrMaxInferenceBatchSize: Math.max(1, parseIntegerSetting(localStorage.getItem(ASR_RUNTIME_STORAGE_KEYS.localAsrMaxInferenceBatchSize) || localStorage.getItem('qwen_asr_max_inference_batch_size'), DEFAULT_ASR_RUNTIME_SETTINGS.localAsrMaxInferenceBatchSize)),
        localAsrMaxNewTokens: Math.max(32, parseIntegerSetting(localStorage.getItem(ASR_RUNTIME_STORAGE_KEYS.localAsrMaxNewTokens) || localStorage.getItem('qwen_asr_max_new_tokens'), DEFAULT_ASR_RUNTIME_SETTINGS.localAsrMaxNewTokens))
    };
}

export function persistAsrRuntimeSettings(settings: AsrRuntimeSettings) {
    localStorage.setItem(ASR_RUNTIME_STORAGE_KEYS.whisperVadOnset, settings.whisperVadOnset.toString());
    localStorage.setItem(ASR_RUNTIME_STORAGE_KEYS.whisperVadOffset, settings.whisperVadOffset.toString());
    localStorage.setItem(ASR_RUNTIME_STORAGE_KEYS.fasterWhisperVadFilter, String(settings.fasterWhisperVadFilter));
    localStorage.setItem(ASR_RUNTIME_STORAGE_KEYS.fasterWhisperVadThreshold, settings.fasterWhisperVadThreshold.toString());
    localStorage.setItem(ASR_RUNTIME_STORAGE_KEYS.funAsrBatchSizeSeconds, settings.funAsrBatchSizeSeconds.toString());
    localStorage.setItem(ASR_RUNTIME_STORAGE_KEYS.funAsrMergeVad, String(settings.funAsrMergeVad));
    localStorage.setItem(ASR_RUNTIME_STORAGE_KEYS.localAsrDevice, settings.localAsrDevice);
    localStorage.setItem(ASR_RUNTIME_STORAGE_KEYS.localAsrMaxInferenceBatchSize, settings.localAsrMaxInferenceBatchSize.toString());
    localStorage.setItem(ASR_RUNTIME_STORAGE_KEYS.localAsrMaxNewTokens, settings.localAsrMaxNewTokens.toString());
}

export function appendStoredAsrArgs(args: string[] | { args?: string[] }) {
    const argList = resolveArgList(args);
    const settings = getStoredAsrRuntimeSettings();
    argList.push('--vad_onset', settings.whisperVadOnset.toFixed(3));
    argList.push('--vad_offset', settings.whisperVadOffset.toFixed(3));
    argList.push('--faster_whisper_vad_filter', settings.fasterWhisperVadFilter ? 'true' : 'false');
    argList.push('--faster_whisper_vad_threshold', settings.fasterWhisperVadThreshold.toFixed(3));
    argList.push('--funasr_batch_size_s', String(settings.funAsrBatchSizeSeconds));
    argList.push('--funasr_merge_vad', settings.funAsrMergeVad ? 'true' : 'false');
    argList.push('--local_asr_device', settings.localAsrDevice);
    argList.push('--local_asr_max_inference_batch_size', String(settings.localAsrMaxInferenceBatchSize));
    argList.push('--local_asr_max_new_tokens', String(settings.localAsrMaxNewTokens));
    return settings;
}

export function getStoredQwenTtsSettings(): QwenTtsSettings {
    return {
        mode: (localStorage.getItem('qwen_mode') as QwenTtsSettings['mode']) || 'clone',
        modelSize: getStoredTtsModelProfile('qwen') === 'fast' ? '0.6B' : '1.7B',
        presetVoice: localStorage.getItem('qwen_preset_voice') || 'Vivian',
        voiceInstruction: localStorage.getItem('qwen_voice_instruction') || '',
        designRefAudio: localStorage.getItem('qwen_design_ref_audio') || '',
        refAudio: localStorage.getItem('qwen_ref_audio_path') || '',
        refText: localStorage.getItem('qwen_ref_text') || ''
    };
}

export function getStoredGptSovitsTtsSettings(): GptSovitsTtsSettings {
    const profile = getStoredTtsModelProfile('gptsovits');
    const defaults = GPT_SOVITS_PROFILE_DEFAULTS[profile === 'fast' || profile === 'quality' ? profile : 'balanced'];
    const storedSplitMethod = localStorage.getItem('gpt_sovits_text_split_method');
    const textSplitMethod = storedSplitMethod && ['cut0', 'cut1', 'cut2', 'cut3', 'cut4', 'cut5'].includes(storedSplitMethod)
        ? storedSplitMethod as GptSovitsTtsSettings['textSplitMethod']
        : defaults.textSplitMethod;
    const speedFactor = parseNumberSetting(localStorage.getItem('gpt_sovits_speed_factor'), defaults.speedFactor);
    const batchThreshold = parseNumberSetting(localStorage.getItem('gpt_sovits_batch_threshold'), defaults.batchThreshold);
    const sampleSteps = Math.max(8, parseIntegerSetting(localStorage.getItem('gpt_sovits_sample_steps'), defaults.sampleSteps));
    return {
        refAudio: localStorage.getItem('gpt_sovits_ref_audio_path') || GPT_SOVITS_BUILTIN_VOICE_JING_YUAN,
        promptText: localStorage.getItem('gpt_sovits_prompt_text') || GPT_SOVITS_BUILTIN_PROMPT_JING_YUAN,
        textSplitMethod,
        speedFactor: Math.min(Math.max(speedFactor, 0.6), 1.4),
        batchThreshold: Math.min(Math.max(batchThreshold, 0.1), 3.0),
        parallelInfer: localStorage.getItem('gpt_sovits_parallel_infer') === null ? defaults.parallelInfer : localStorage.getItem('gpt_sovits_parallel_infer') !== 'false',
        sampleSteps,
        officialFastMode: localStorage.getItem('gpt_sovits_official_fast_mode') === null ? defaults.officialFastMode : localStorage.getItem('gpt_sovits_official_fast_mode') !== 'false'
    };
}

export function getRecommendedGptSovitsTtsSettings(
    profile: string,
    current?: Partial<GptSovitsTtsSettings>
): GptSovitsTtsSettings {
    const preset = GPT_SOVITS_PROFILE_DEFAULTS[profile === 'fast' || profile === 'quality' ? profile : 'balanced'];
    return {
        refAudio: current?.refAudio || GPT_SOVITS_BUILTIN_VOICE_JING_YUAN,
        promptText: current?.promptText || GPT_SOVITS_BUILTIN_PROMPT_JING_YUAN,
        textSplitMethod: preset.textSplitMethod,
        speedFactor: preset.speedFactor,
        batchThreshold: preset.batchThreshold,
        parallelInfer: preset.parallelInfer,
        sampleSteps: preset.sampleSteps,
        officialFastMode: preset.officialFastMode
    };
}

export function getStoredTtsVoiceMode(ttsService?: string): TtsVoiceMode {
    const stored = localStorage.getItem('tts_voice_mode');
    if (!stored) {
        return ttsService === 'gptsovits' ? 'narration' : 'clone';
    }
    return stored === 'narration' ? 'narration' : 'clone';
}
