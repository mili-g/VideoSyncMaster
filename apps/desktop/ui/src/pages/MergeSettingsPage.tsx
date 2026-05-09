import MergeConfig from '../components/MergeConfig';
import type { AudioMixMode } from '../hooks/useVideoProject';
import PageFrame from '../layout/PageFrame';

interface MergeSettingsPageProps {
    videoStrategy: string;
    audioMixMode: AudioMixMode;
    setVideoStrategy: (strategy: string) => void;
    setAudioMixMode: (mode: AudioMixMode) => void;
}

export default function MergeSettingsPage(props: MergeSettingsPageProps) {
    return (
        <div className="view-page-shell">
            <PageFrame
                eyebrow="Delivery"
                title="合成配置"
                description=""
                headerMode="hidden"
            >
                <MergeConfig themeMode="dark" {...props} />
            </PageFrame>
        </div>
    );
}
