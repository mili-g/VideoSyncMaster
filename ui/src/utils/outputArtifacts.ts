import { segmentsToSRT, type SrtSegment } from './srt';

function sanitizeBaseName(fileName: string) {
    return fileName.replace(/\.[^/.]+$/, '');
}

export function buildOutputArtifacts(outputDir: string, fileName: string) {
    const baseName = sanitizeBaseName(fileName);
    return {
        baseName,
        originalSubtitlePath: `${outputDir}\\${baseName}.original.srt`,
        translatedSubtitlePath: `${outputDir}\\${baseName}.en.srt`,
        mergedVideoPath: `${outputDir}\\${fileName}`
    };
}

export async function saveSubtitleArtifacts(
    outputDir: string,
    fileName: string,
    originalSegments: SrtSegment[],
    translatedSegments: SrtSegment[]
) {
    const artifacts = buildOutputArtifacts(outputDir, fileName);
    await window.api.ensureDir(outputDir);
    await Promise.all([
        window.api.saveFile(artifacts.originalSubtitlePath, segmentsToSRT(originalSegments)),
        window.api.saveFile(artifacts.translatedSubtitlePath, segmentsToSRT(translatedSegments))
    ]);
    return artifacts;
}

export async function cleanupOutputArtifacts(
    _outputDir: string,
    extraPaths: string[] = []
) {
    if (extraPaths.length === 0) {
        return;
    }
    await Promise.all(extraPaths.map((targetPath) => window.api.deletePath(targetPath)));
}
