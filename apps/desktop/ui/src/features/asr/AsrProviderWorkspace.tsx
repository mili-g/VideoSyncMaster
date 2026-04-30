import React from 'react';
import type { AsrService } from '../../utils/asrService';
import type { AsrProviderPanelProps } from './types';
import FasterWhisperPanel from './providers/FasterWhisperPanel';
import FunAsrPanel from './providers/FunAsrPanel';
import QwenAsrPanel from './providers/QwenAsrPanel';
import VibeVoiceAsrPanel from './providers/VibeVoiceAsrPanel';
import JianyingApiPanel from './providers/JianyingApiPanel';
import BcutApiPanel from './providers/BcutApiPanel';

const panelRegistry: Record<AsrService, React.ComponentType<AsrProviderPanelProps>> = {
    'faster-whisper': FasterWhisperPanel,
    funasr: FunAsrPanel,
    qwen: QwenAsrPanel,
    'vibevoice-asr': VibeVoiceAsrPanel,
    jianying: JianyingApiPanel,
    bcut: BcutApiPanel
};

export default function AsrProviderWorkspace(props: AsrProviderPanelProps) {
    const Panel = panelRegistry[props.service];
    return <Panel {...props} />;
}
