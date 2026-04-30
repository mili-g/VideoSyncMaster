import React from 'react';
import TTSConfig from '../components/TTSConfig';
import PageFrame from '../layout/PageFrame';

interface TtsSettingsPageProps {
    activeService: 'indextts' | 'qwen';
    onServiceChange: (service: 'indextts' | 'qwen') => Promise<boolean>;
    ttsModelProfiles: Record<'indextts' | 'qwen', string>;
    setTtsModelProfiles: React.Dispatch<React.SetStateAction<Record<'indextts' | 'qwen', string>>>;
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
                description="统一管理配音引擎、音色模式与生成参数。"
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
