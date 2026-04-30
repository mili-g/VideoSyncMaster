import { Segment } from '../components/Timeline';

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
    const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const regex = /(\d+)\s*\n\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*\n([\s\S]*?)(?=\n\d+\s*\n\s*\d{2}:\d{2}[:.]|$)/g;
    const segments: SrtSegment[] = [];
    let match: RegExpExecArray | null;

    const parseTime = (timestamp: string) => {
        const cleanTimestamp = timestamp.replace(',', '.');
        const [hours, minutes, seconds] = cleanTimestamp.split(':');
        return parseFloat(hours) * 3600 + parseFloat(minutes) * 60 + parseFloat(seconds);
    };

    while ((match = regex.exec(normalizedText)) !== null) {
        const content = match[4].trim();
        if (!content) continue;

        segments.push({
            start: parseTime(match[2]),
            end: parseTime(match[3]),
            text: content
        });
    }

    return segments;
}
