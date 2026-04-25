export interface TranslationApiSettings {
    apiKey: string;
    baseUrl: string;
    model: string;
}

export interface WhisperVadSettings {
    onset: string;
    offset: string;
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

export function getStoredTranslationApiSettings(): TranslationApiSettings {
    return {
        apiKey: localStorage.getItem('trans_api_key') || '',
        baseUrl: localStorage.getItem('trans_api_base_url') || '',
        model: localStorage.getItem('trans_api_model') || ''
    };
}

export function appendStoredTranslationArgs(args: string[]) {
    const settings = getStoredTranslationApiSettings();
    if (!settings.apiKey) {
        return settings;
    }

    args.push('--api_key', settings.apiKey);
    if (settings.baseUrl) args.push('--base_url', settings.baseUrl);
    if (settings.model) args.push('--model', settings.model);
    return settings;
}

export function getStoredWhisperVadSettings(): WhisperVadSettings {
    return {
        onset: localStorage.getItem('whisper_vad_onset') || '0.700',
        offset: localStorage.getItem('whisper_vad_offset') || '0.700'
    };
}

export function getStoredQwenTtsSettings(): QwenTtsSettings {
    return {
        mode: (localStorage.getItem('qwen_mode') as QwenTtsSettings['mode']) || 'clone',
        modelSize: localStorage.getItem('qwen_tts_model') || '1.7B',
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
