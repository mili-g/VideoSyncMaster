export interface ParsedSubtitleSegment {
    start: number;
    end: number;
    text: string;
}

export const SUPPORTED_SUBTITLE_EXTENSIONS = ['.srt', '.vtt'] as const;

export const SUBTITLE_FILE_ACCEPT = SUPPORTED_SUBTITLE_EXTENSIONS.join(',');

const suspiciousMojibakePattern = /[\uFFFD\u00C3\u00E2\u00D0\u00CF]/;

export function isSupportedSubtitleFileName(fileName: string) {
    const lower = String(fileName || '').toLowerCase();
    return SUPPORTED_SUBTITLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export async function decodeSubtitleFile(file: File) {
    const buffer = await file.arrayBuffer();
    return decodeSubtitleBuffer(buffer);
}

export function decodeSubtitleBuffer(buffer: ArrayBuffer) {
    try {
        const utf8Text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        if (!suspiciousMojibakePattern.test(utf8Text)) {
            return utf8Text;
        }
    } catch (error) {
        console.warn('UTF-8 subtitle decode failed, falling back to gb18030:', error);
    }

    const gb18030Text = new TextDecoder('gb18030').decode(buffer);
    return gb18030Text || new TextDecoder('utf-8').decode(buffer);
}

function normalizeSubtitleText(text: string) {
    return String(text || '')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();
}

function parseSubtitleTimestamp(timestamp: string) {
    const normalized = timestamp.trim().replace(',', '.');
    const parts = normalized.split(':');

    if (parts.length < 2 || parts.length > 3) {
        return null;
    }

    const secondsPart = Number.parseFloat(parts[parts.length - 1]);
    const minutesPart = Number.parseInt(parts[parts.length - 2], 10);
    const hoursPart = parts.length === 3 ? Number.parseInt(parts[0], 10) : 0;

    if (!Number.isFinite(hoursPart) || !Number.isFinite(minutesPart) || !Number.isFinite(secondsPart)) {
        return null;
    }

    return (hoursPart * 3600) + (minutesPart * 60) + secondsPart;
}

function extractCueTiming(line: string) {
    const match = line.match(
        /^\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$/
    );
    if (!match) {
        return null;
    }

    const start = parseSubtitleTimestamp(match[1]);
    const end = parseSubtitleTimestamp(match[2]);
    if (start === null || end === null) {
        return null;
    }

    return { start, end };
}

export function parseSubtitleContent(text: string): ParsedSubtitleSegment[] {
    const normalizedText = normalizeSubtitleText(text);
    if (!normalizedText) {
        return [];
    }

    const blocks = normalizedText.split(/\n{2,}/);
    const segments: ParsedSubtitleSegment[] = [];

    for (const block of blocks) {
        const lines = block
            .split('\n')
            .map((line) => line.trimEnd())
            .filter(Boolean);

        if (lines.length === 0) {
            continue;
        }

        const firstLine = lines[0].trim();
        if (
            firstLine === 'WEBVTT'
            || firstLine.startsWith('NOTE')
            || firstLine === 'STYLE'
            || firstLine === 'REGION'
            || firstLine.startsWith('X-TIMESTAMP-MAP')
        ) {
            continue;
        }

        const timingLineIndex = lines.findIndex((line) => line.includes('-->'));
        if (timingLineIndex < 0) {
            continue;
        }

        const timing = extractCueTiming(lines[timingLineIndex]);
        if (!timing) {
            continue;
        }

        const content = lines
            .slice(timingLineIndex + 1)
            .join('\n')
            .trim();

        if (!content) {
            continue;
        }

        segments.push({
            start: timing.start,
            end: timing.end,
            text: content
        });
    }

    return segments;
}
