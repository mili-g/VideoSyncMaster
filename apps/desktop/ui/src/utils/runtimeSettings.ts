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

export type TtsVoiceMode = 'clone' | 'narration';

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
    if (!settings.apiKey) {
        return settings;
    }

    argList.push('--api_key', settings.apiKey);
    if (settings.baseUrl) argList.push('--base_url', settings.baseUrl);
    if (settings.model) argList.push('--model', settings.model);
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

export function getStoredTtsVoiceMode(): TtsVoiceMode {
    const stored = localStorage.getItem('tts_voice_mode');
    return stored === 'narration' ? 'narration' : 'clone';
}
