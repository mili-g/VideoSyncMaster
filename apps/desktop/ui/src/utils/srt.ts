import { Segment } from '../components/Timeline';
import { parseSubtitleContent } from './subtitleFormats';

export interface SrtSegment {
    start: number;
    end: number;
    text: string;
}

export function formatSRTTime(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

export function segmentsToSRT(segments: Segment[]): string {
    return segments
        .map((seg, index) => {
            const startStr = formatSRTTime(seg.start);
            const endStr = formatSRTTime(seg.end);
            return `${index + 1}\n${startStr} --> ${endStr}\n${seg.text}\n`;
        })
        .join('\n');
}

export function parseSRTContent(text: string): SrtSegment[] {
    return parseSubtitleContent(text);
}
