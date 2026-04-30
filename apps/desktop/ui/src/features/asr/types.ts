import type { AsrService } from '../../utils/asrService';
import type { AsrRuntimeSettings } from '../../utils/runtimeSettings';

export interface AsrProviderPanelProps {
    service: AsrService;
    profileId: string;
    profileDescription?: string;
    onProfileChange: (profileId: string) => void;
    runtimeSettings: AsrRuntimeSettings;
    updateRuntimeSetting: <K extends keyof AsrRuntimeSettings>(key: K, value: AsrRuntimeSettings[K]) => void;
}
