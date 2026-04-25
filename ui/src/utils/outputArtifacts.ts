import { segmentsToSRT, type SrtSegment } from './srt';

function sanitizeBaseName(fileName: string) {
    return fileName.replace(/\.[^/.]+$/, '');
}

export function buildOutputArtifacts(outputDir: string, fileName: string) {
    const baseName = sanitizeBaseName(fileName);
    return {
        baseName,
        originalSubtitlePath: `${outputDir}\\${baseName}.en.srt`,
        translatedSubtitlePath: `${outputDir}\\${baseName}.zh-CN.srt`,
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
    const normalizedPaths = Array.from(
        new Set(
            extraPaths
                .filter((targetPath): targetPath is string => Boolean(targetPath))
                .sort((left, right) => right.length - left.length)
        )
    );

    for (const targetPath of normalizedPaths) {
        await window.api.deletePath(targetPath);
    }
}
