import { Segment } from '../components/Timeline';

/**
 * Formats seconds into SRT timestamp string: HH:MM:SS,mmm
 */
export function formatSRTTime(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

/**
 * Converts an array of subtitle segments into a standard SRT string.
 */
export function segmentsToSRT(segments: Segment[]): string {
    return segments
        .map((seg, index) => {
            const startStr = formatSRTTime(seg.start);
            const endStr = formatSRTTime(seg.end);
            return `${index + 1}\n${startStr} --> ${endStr}\n${seg.text}\n`;
        })
        .join('\n');
}
