import type { Segment } from '../hooks/useVideoProject';
import { validateSubtitleLanguageFit } from './batchAssets';

export interface SubtitleLanguageGuardResult {
    ok: boolean;
    reason?: string;
}

export function validateSegmentLanguageFit(
    segments: Array<Pick<Segment, 'text'>>,
    expectedLanguage: string,
    mode: 'source' | 'target'
): SubtitleLanguageGuardResult {
    const text = segments
        .map(segment => String(segment.text || '').trim())
        .filter(Boolean)
        .join(' ');

    const result = validateSubtitleLanguageFit(text, expectedLanguage, mode);
    return {
        ok: result.ok,
        reason: result.reason
    };
}
