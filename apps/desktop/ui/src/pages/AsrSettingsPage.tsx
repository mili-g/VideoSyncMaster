import React from 'react';
import ASRHub from '../components/ASRHub';
import type { AsrService, AsrSourceLanguage } from '../utils/asrService';
import type { AsrRuntimeSettings } from '../utils/runtimeSettings';

interface AsrSettingsPageProps {
    asrService: string;
    onServiceChange: (service: AsrService) => boolean;
    asrOriLang: AsrSourceLanguage;
    setAsrOriLang: React.Dispatch<React.SetStateAction<AsrSourceLanguage>>;
    asrModelProfiles: Record<AsrService, string>;
    setAsrModelProfiles: React.Dispatch<React.SetStateAction<Record<AsrService, string>>>;
    asrRuntimeSettings: AsrRuntimeSettings;
    setAsrRuntimeSettings: React.Dispatch<React.SetStateAction<AsrRuntimeSettings>>;
}

export default function AsrSettingsPage(props: AsrSettingsPageProps) {
    return (
        <div className="view-page-shell">
            <ASRHub {...props} themeMode="dark" />
        </div>
    );
}
