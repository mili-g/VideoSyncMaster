import { segmentsToSRT, type SrtSegment } from './srt';
import type { SubtitleArtifactLanguages } from './languageTags';

function sanitizeBaseName(fileName: string) {
    return fileName.replace(/\.[^/.]+$/, '');
}

function buildSubtitleArtifactPaths(outputDir: string, baseName: string, sourceLangTag: string, targetLangTag: string) {
    if (sourceLangTag === targetLangTag) {
        return {
            originalSubtitlePath: `${outputDir}\\${baseName}.source.${sourceLangTag}.srt`,
            translatedSubtitlePath: `${outputDir}\\${baseName}.translated.${targetLangTag}.srt`
        };
    }

    return {
        originalSubtitlePath: `${outputDir}\\${baseName}.${sourceLangTag}.srt`,
        translatedSubtitlePath: `${outputDir}\\${baseName}.${targetLangTag}.srt`
    };
}

export function buildOutputArtifacts(
    outputDir: string,
    fileName: string,
    artifactLanguages: SubtitleArtifactLanguages = {}
) {
    const baseName = sanitizeBaseName(fileName);
    const sourceLangTag = artifactLanguages.sourceLangTag || 'und';
    const targetLangTag = artifactLanguages.targetLangTag || 'und';
    const subtitlePaths = buildSubtitleArtifactPaths(outputDir, baseName, sourceLangTag, targetLangTag);
    return {
        baseName,
        originalSubtitlePath: subtitlePaths.originalSubtitlePath,
        translatedSubtitlePath: subtitlePaths.translatedSubtitlePath,
        mergedVideoPath: `${outputDir}\\${fileName}`
    };
}

export async function saveSubtitleArtifacts(
    outputDir: string,
    fileName: string,
    originalSegments: SrtSegment[],
    translatedSegments: SrtSegment[],
    artifactLanguages: SubtitleArtifactLanguages = {}
) {
    const artifacts = buildOutputArtifacts(outputDir, fileName, artifactLanguages);
    await window.api.ensureDir(outputDir);
    await Promise.all([
        window.api.saveFile(artifacts.originalSubtitlePath, segmentsToSRT(originalSegments)),
        window.api.saveFile(artifacts.translatedSubtitlePath, segmentsToSRT(translatedSegments))
    ]);
    return artifacts;
}

export async function saveOriginalSubtitleArtifact(
    outputDir: string,
    fileName: string,
    originalSegments: SrtSegment[],
    artifactLanguages: SubtitleArtifactLanguages = {}
) {
    const artifacts = buildOutputArtifacts(outputDir, fileName, artifactLanguages);
    await window.api.ensureDir(outputDir);
    await window.api.saveFile(artifacts.originalSubtitlePath, segmentsToSRT(originalSegments));
    await window.api.deletePath(artifacts.translatedSubtitlePath);
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
