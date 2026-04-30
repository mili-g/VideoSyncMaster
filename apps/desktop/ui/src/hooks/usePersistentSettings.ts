import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
    ASR_SERVICE_META,
    isSupportedAsrService,
    normalizeAsrSourceLanguage,
    type AsrService,
    type AsrSourceLanguage
} from '../utils/asrService';
import {
    ASR_MODEL_PROFILES,
    TTS_MODEL_PROFILES,
    getStoredAsrModelProfile,
    getStoredTtsModelProfile,
    setStoredAsrModelProfile,
    setStoredTtsModelProfile,
    type TtsService
} from '../utils/modelProfiles';
import {
    DEFAULT_ASR_RUNTIME_SETTINGS,
    getStoredAsrRuntimeSettings,
    persistAsrRuntimeSettings,
    type AsrRuntimeSettings
} from '../utils/runtimeSettings';
import { getRuntimeCombinationNotice } from '../utils/runtimeCompatibility';

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
    const [asrService, setAsrService] = useState<AsrService>(() => {
        const saved = localStorage.getItem('asrService');
        return isSupportedAsrService(saved) ? saved : 'faster-whisper';
    });
    const [asrOriLang, setAsrOriLang] = useState<AsrSourceLanguage>(() => {
        const saved = localStorage.getItem('asrOriLang');
        const normalized = normalizeAsrSourceLanguage(saved);
        const savedService = localStorage.getItem('asrService');
        if (isSupportedAsrService(savedService) && ASR_SERVICE_META[savedService].sourceLanguageMode === 'auto_only') {
            return 'Auto';
        }
        return normalized;
    });
    const [ttsService, setTtsService] = useState<'indextts' | 'qwen'>(() => {
        const saved = localStorage.getItem('ttsService');
        return saved === 'indextts' || saved === 'qwen' ? (saved as 'indextts' | 'qwen') : 'qwen';
    });
    const [asrModelProfiles, setAsrModelProfiles] = useState<Record<AsrService, string>>(() => ({
        bcut: getStoredAsrModelProfile('bcut'),
        jianying: getStoredAsrModelProfile('jianying'),
        funasr: getStoredAsrModelProfile('funasr'),
        'faster-whisper': getStoredAsrModelProfile('faster-whisper'),
        qwen: getStoredAsrModelProfile('qwen'),
        'vibevoice-asr': getStoredAsrModelProfile('vibevoice-asr')
    }));
    const [ttsModelProfiles, setTtsModelProfiles] = useState<Record<TtsService, string>>(() => ({
        indextts: getStoredTtsModelProfile('indextts'),
        qwen: getStoredTtsModelProfile('qwen')
    }));
    const [asrRuntimeSettings, setAsrRuntimeSettings] = useState<AsrRuntimeSettings>(() => getStoredAsrRuntimeSettings());
    const [batchSize, setBatchSize] = useState(() => parseInt(localStorage.getItem('batchSize') || '1', 10));
    const [cloneBatchSize, setCloneBatchSize] = useState(() => parseInt(localStorage.getItem('cloneBatchSize') || '1', 10));
    const [maxNewTokens, setMaxNewTokens] = useState(() => parseInt(localStorage.getItem('maxNewTokens') || '4096', 10));

    const handleAsrServiceChange = (newService: AsrService) => {
        const notice = getRuntimeCombinationNotice(newService, ttsService);
        if (notice) {
            setFeedback({ title: '运行时提示', message: notice.message, type: 'success' });
        }
        setAsrService(newService);
        return true;
    };

    const handleTtsServiceChange = (newService: 'indextts' | 'qwen') => {
        const notice = getRuntimeCombinationNotice(asrService, newService);
        if (notice) {
            setFeedback({ title: '运行时提示', message: notice.message, type: 'success' });
        }
        setTtsService(newService);
        return true;
    };

    useEffect(() => { localStorage.setItem('targetLang', targetLang); }, [targetLang]);
    useEffect(() => { localStorage.setItem('asrService', asrService); }, [asrService]);
    useEffect(() => { localStorage.setItem('asrOriLang', asrOriLang); }, [asrOriLang]);
    useEffect(() => {
        if (ASR_SERVICE_META[asrService].sourceLanguageMode === 'auto_only' && asrOriLang !== 'Auto') {
            setAsrOriLang('Auto');
        }
    }, [asrOriLang, asrService]);
    useEffect(() => { localStorage.setItem('ttsService', ttsService); }, [ttsService]);
    useEffect(() => {
        (Object.keys(asrModelProfiles) as AsrService[]).forEach(service => {
            const profileId = asrModelProfiles[service];
            if (ASR_MODEL_PROFILES[service].some(option => option.id === profileId)) {
                setStoredAsrModelProfile(service, profileId);
            }
        });
    }, [asrModelProfiles]);
    useEffect(() => {
        (Object.keys(ttsModelProfiles) as TtsService[]).forEach(service => {
            const profileId = ttsModelProfiles[service];
            if (TTS_MODEL_PROFILES[service].some(option => option.id === profileId)) {
                setStoredTtsModelProfile(service, profileId);
            }
        });
    }, [ttsModelProfiles]);
    useEffect(() => {
        persistAsrRuntimeSettings({
            ...DEFAULT_ASR_RUNTIME_SETTINGS,
            ...asrRuntimeSettings
        });
    }, [asrRuntimeSettings]);
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
        asrModelProfiles,
        setAsrModelProfiles,
        asrRuntimeSettings,
        setAsrRuntimeSettings,
        ttsModelProfiles,
        setTtsModelProfiles,
        batchSize,
        setBatchSize,
        cloneBatchSize,
        setCloneBatchSize,
        maxNewTokens,
        setMaxNewTokens
    };
}
