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
        mergedVideoPath: `${outputDir}\\merged.mp4`,
        mergeJsonPath: `${outputDir}\\segments.json`,
        sourceCacheDir: `${outputDir}\\.cache`,
        mergedSegmentsDir: `${outputDir}\\merged_segments`
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
    await window.api.saveFile(artifacts.originalSubtitlePath, segmentsToSRT(originalSegments));
    await window.api.saveFile(artifacts.translatedSubtitlePath, segmentsToSRT(translatedSegments));
    return artifacts;
}

export async function cleanupOutputArtifacts(
    outputDir: string,
    extraPaths: string[] = []
) {
    const paths = [
        `${outputDir}\\.cache`,
        `${outputDir}\\merged_segments`,
        ...extraPaths
    ];

    await Promise.all(paths.map((targetPath) => window.api.deletePath(targetPath)));
}
