import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

type FeedbackType = 'success' | 'error';

interface FeedbackPayload {
    title: string;
    message: string;
    type: FeedbackType;
}

interface PersistentSettingsOptions {
    setFeedback: Dispatch<SetStateAction<FeedbackPayload | null>>;
}

export function usePersistentSettings({ setFeedback }: PersistentSettingsOptions) {
    const [targetLang, setTargetLang] = useState(() => localStorage.getItem('targetLang') || 'English');
    const [asrService, setAsrService] = useState(() => localStorage.getItem('asrService') || 'whisperx');
    const [asrOriLang, setAsrOriLang] = useState('Auto');
    const [ttsService, setTtsService] = useState<'indextts' | 'qwen'>(() => {
        const saved = localStorage.getItem('ttsService');
        return saved === 'qwen' ? 'qwen' : 'indextts';
    });
    const [batchSize, setBatchSize] = useState(() => parseInt(localStorage.getItem('batchSize') || '1', 10));
    const [cloneBatchSize, setCloneBatchSize] = useState(() => parseInt(localStorage.getItem('cloneBatchSize') || '1', 10));
    const [maxNewTokens, setMaxNewTokens] = useState(() => parseInt(localStorage.getItem('maxNewTokens') || '4096', 10));

    const validateServiceIncompatibility = (
        asr: string,
        tts: string,
        changing: 'asr' | 'tts'
    ): { valid: boolean; message?: string } => {
        if (asr === 'qwen' && tts === 'indextts') {
            if (changing === 'asr') {
                return {
                    valid: false,
                    message: "【环境冲突】Qwen3 ASR 无法与 Index-TTS 同时启用。请先进入【配音配置】将引擎从 Index-TTS 切换为 Qwen3。"
                };
            }

            return {
                valid: false,
                message: "【环境冲突】Index-TTS 无法与 Qwen3 ASR 同时启用。请先进入【识别中心】将引擎从 Qwen3 切换为 WhisperX 或云端 API。"
            };
        }

        return { valid: true };
    };

    const handleAsrServiceChange = (newService: string) => {
        const check = validateServiceIncompatibility(newService, ttsService, 'asr');
        if (!check.valid) {
            setFeedback({ title: "选择冲突", message: check.message!, type: 'error' });
            return false;
        }

        setAsrService(newService);
        return true;
    };

    const handleTtsServiceChange = (newService: 'indextts' | 'qwen') => {
        const check = validateServiceIncompatibility(asrService, newService, 'tts');
        if (!check.valid) {
            setFeedback({ title: "选择冲突", message: check.message!, type: 'error' });
            return false;
        }

        setTtsService(newService);
        return true;
    };

    useEffect(() => { localStorage.setItem('targetLang', targetLang); }, [targetLang]);
    useEffect(() => { localStorage.setItem('asrService', asrService); }, [asrService]);
    useEffect(() => {
        if (asrOriLang !== 'Auto') {
            setAsrOriLang('Auto');
            return;
        }
        localStorage.setItem('asrOriLang', 'Auto');
    }, [asrOriLang]);
    useEffect(() => { localStorage.setItem('ttsService', ttsService); }, [ttsService]);
    useEffect(() => { localStorage.setItem('batchSize', batchSize.toString()); }, [batchSize]);
    useEffect(() => { localStorage.setItem('cloneBatchSize', cloneBatchSize.toString()); }, [cloneBatchSize]);
    useEffect(() => { localStorage.setItem('maxNewTokens', maxNewTokens.toString()); }, [maxNewTokens]);

    return {
        targetLang,
        setTargetLang,
        asrService,
        setAsrService,
        handleAsrServiceChange,
        asrOriLang,
        setAsrOriLang,
        ttsService,
        setTtsService,
        handleTtsServiceChange,
        batchSize,
        setBatchSize,
        cloneBatchSize,
        setCloneBatchSize,
        maxNewTokens,
        setMaxNewTokens
    };
}
