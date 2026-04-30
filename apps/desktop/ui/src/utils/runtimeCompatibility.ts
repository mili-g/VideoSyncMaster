import type { AsrService } from './asrService';
import type { TtsService } from './modelProfiles';

export interface RuntimeCombinationNotice {
    level: 'info' | 'warning';
    message: string;
}

const transformerAsrServices = new Set<AsrService>(['qwen', 'vibevoice-asr']);

export function getRuntimeCombinationNotice(asrService: AsrService, ttsService: TtsService): RuntimeCombinationNotice | null {
    if (transformerAsrServices.has(asrService) && ttsService === 'indextts') {
        return {
            level: 'warning',
            message: '当前组合会分别使用本地 ASR Runtime 和 TTS Runtime。首次切换或首次执行时可能需要额外预热，但不应再被前端直接拦截。'
        };
    }

    return null;
}
