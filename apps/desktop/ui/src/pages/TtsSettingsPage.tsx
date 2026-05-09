import React from 'react';
import TTSConfig from '../components/TTSConfig';
import PageFrame from '../layout/PageFrame';
import type { TtsService } from '../utils/modelProfiles';

interface TtsSettingsPageProps {
    activeService: TtsService;
    onServiceChange: (service: TtsService) => Promise<boolean>;
    ttsModelProfiles: Record<TtsService, string>;
    setTtsModelProfiles: React.Dispatch<React.SetStateAction<Record<TtsService, string>>>;
    batchSize: number;
    setBatchSize: (size: number) => void;
    cloneBatchSize: number;
    setCloneBatchSize: (size: number) => void;
    maxNewTokens: number;
    setMaxNewTokens: (token: number) => void;
}

export default function TtsSettingsPage(props: TtsSettingsPageProps) {
    return (
        <div className="view-page-shell">
            <PageFrame
                eyebrow="Speech"
                title="配音中心"
                description=""
                headerMode="hidden"
            >
                <TTSConfig
                    themeMode="dark"
                    onQwenModeChange={() => {}}
                    {...props}
                />
            </PageFrame>
        </div>
    );
}
