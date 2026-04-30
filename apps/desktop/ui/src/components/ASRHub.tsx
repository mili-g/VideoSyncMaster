import React, { useEffect } from 'react';
import PageFrame from '../layout/PageFrame';
import {
    ASR_SERVICE_META,
    ASR_SOURCE_LANGUAGE_OPTIONS,
    getAsrSourceLanguageLabel,
    getAsrSourceLanguageHint,
    type AsrService,
    type AsrSourceLanguage,
    SUPPORTED_ASR_SERVICES
} from '../utils/asrService';
import { ASR_MODEL_PROFILES } from '../utils/modelProfiles';
import {
    DEFAULT_ASR_RUNTIME_SETTINGS,
    type AsrRuntimeSettings
} from '../utils/runtimeSettings';
import AsrProviderWorkspace from '../features/asr/AsrProviderWorkspace';
import { SelectField } from '../features/asr/shared';

interface ASRHubProps {
    themeMode?: 'light' | 'dark' | 'gradient';
    asrService: string;
    onServiceChange: (service: AsrService) => boolean;
    asrOriLang: AsrSourceLanguage;
    setAsrOriLang: React.Dispatch<React.SetStateAction<AsrSourceLanguage>>;
    asrModelProfiles: Record<AsrService, string>;
    setAsrModelProfiles: React.Dispatch<React.SetStateAction<Record<AsrService, string>>>;
    asrRuntimeSettings: AsrRuntimeSettings;
    setAsrRuntimeSettings: React.Dispatch<React.SetStateAction<AsrRuntimeSettings>>;
}

const localServiceSet = new Set<AsrService>(['faster-whisper', 'funasr', 'qwen', 'vibevoice-asr']);

export default function ASRHub({
    asrService,
    onServiceChange,
    asrOriLang,
    setAsrOriLang,
    asrModelProfiles,
    setAsrModelProfiles,
    asrRuntimeSettings,
    setAsrRuntimeSettings
}: ASRHubProps) {
    const currentService = (asrService in ASR_SERVICE_META ? asrService : 'faster-whisper') as AsrService;

    useEffect(() => {
        setAsrRuntimeSettings((prev) => ({
            ...DEFAULT_ASR_RUNTIME_SETTINGS,
            ...prev
        }));
    }, [setAsrRuntimeSettings]);

    const currentProfiles = ASR_MODEL_PROFILES[currentService];
    const activeProfile = currentProfiles.find((option) => option.id === asrModelProfiles[currentService]) ?? currentProfiles[0];
    const sourceLanguageOptions = ASR_SERVICE_META[currentService].sourceLanguageMode === 'auto_only'
        ? ASR_SOURCE_LANGUAGE_OPTIONS.filter((value) => value === 'Auto')
        : ASR_SOURCE_LANGUAGE_OPTIONS;

    const updateRuntimeSetting = <K extends keyof AsrRuntimeSettings>(key: K, value: AsrRuntimeSettings[K]) => {
        setAsrRuntimeSettings((prev) => ({
            ...prev,
            [key]: value
        }));
    };

    const handleProfileChange = (profileId: string) => {
        setAsrModelProfiles((prev) => ({
            ...prev,
            [currentService]: profileId
        }));
    };

    return (
        <PageFrame
            eyebrow="Recognition"
            title="识别中心"
            description="只保留会直接影响识别结果的设置。"
            headerMode="hidden"
        >
                <div className="config-section">
                    <div className="config-section__head">
                        <div>
                            <h3>识别引擎</h3>
                            <p>切换当前任务的识别后端。</p>
                        </div>
                        <div className="status-inline">
                            {ASR_SERVICE_META[currentService].shortName} / {localServiceSet.has(currentService) ? '本地' : '云端'}
                        </div>
                    </div>
                    <div className="provider-tab-row" role="tablist" aria-label="ASR quick switch">
                        {SUPPORTED_ASR_SERVICES.map((serviceId) => {
                            const isActive = currentService === serviceId;
                            const meta = ASR_SERVICE_META[serviceId];
                            const availabilityLabel = meta.availability === 'blocked'
                                ? '受限'
                                : meta.availability === 'limited'
                                    ? '实验'
                                    : localServiceSet.has(serviceId)
                                        ? '本地'
                                        : '云端';
                            return (
                                <button
                                    key={serviceId}
                                    type="button"
                                    role="tab"
                                    aria-selected={isActive}
                                    className={`provider-tab${isActive ? ' provider-tab--active' : ''}`}
                                    onClick={() => {
                                        onServiceChange(serviceId);
                                    }}
                                    title={meta.availability === 'blocked' ? meta.detailBody : meta.description}
                                >
                                    <span>{meta.shortName}</span>
                                    <small>
                                        {meta.supportsWorkflowSubtitlePipeline
                                            ? availabilityLabel
                                            : meta.availability === 'limited'
                                                ? '仅文本 / 实验'
                                                : '仅文本'}
                                    </small>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="config-section">
                    <div className="config-section__head">
                        <div>
                            <h3>源语言</h3>
                            <p>语言指定只在支持的引擎上生效。</p>
                        </div>
                        <div className="status-inline">
                            {ASR_SERVICE_META[currentService].sourceLanguageMode === 'auto_only' ? '自动识别' : '自动 / 指定'}
                        </div>
                    </div>
                    <SelectField
                        label="输入语种"
                        value={asrOriLang}
                        onChange={(value) => setAsrOriLang(value as AsrSourceLanguage)}
                        options={sourceLanguageOptions.map((value) => ({
                            value,
                            label: getAsrSourceLanguageLabel(value)
                        }))}
                        hint={getAsrSourceLanguageHint(currentService)}
                    />
                </div>

                <AsrProviderWorkspace
                    service={currentService}
                    profileId={activeProfile.id}
                    profileDescription={activeProfile.description}
                    onProfileChange={handleProfileChange}
                    runtimeSettings={asrRuntimeSettings}
                    updateRuntimeSetting={updateRuntimeSetting}
                />
        </PageFrame>
    );
}
