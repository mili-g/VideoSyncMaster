import type { SubtitleArtifactLanguages } from './languageTags';

function sanitizeBaseName(fileName: string) {
    return fileName.replace(/\.[^/.]+$/, '');
}

function buildSubtitleArtifactPaths(finalDir: string, baseName: string, sourceLangTag: string, targetLangTag: string) {
    if (sourceLangTag === targetLangTag) {
        return {
            originalSubtitlePath: `${finalDir}\\${baseName}.source.${sourceLangTag}.srt`,
            translatedSubtitlePath: `${finalDir}\\${baseName}.translated.${targetLangTag}.srt`
        };
    }

    return {
        originalSubtitlePath: `${finalDir}\\${baseName}.${sourceLangTag}.srt`,
        translatedSubtitlePath: `${finalDir}\\${baseName}.${targetLangTag}.srt`
    };
}

function sanitizePathSegment(value: string) {
    const sanitized = Array.from(value, (char) => {
        const code = char.charCodeAt(0);
        const isWindowsReserved = '<>:"/\\|?*'.includes(char);
        return isWindowsReserved || code <= 31 ? '_' : char;
    }).join('');

    return sanitized.trim() || 'untitled';
}

function buildSessionKey(fileName: string) {
    return sanitizePathSegment(sanitizeBaseName(fileName));
}

export interface DesktopProjectPaths {
    projectRoot: string;
    outputDir: string;
    cacheDir: string;
}

export interface SingleProjectOutputPaths {
    baseName: string;
    sessionKey: string;
    outputDir: string;
    finalDir: string;
    finalVideoPath: string;
    originalSubtitlePath: string;
    translatedSubtitlePath: string;
    sessionCacheDir: string;
    sessionManifestPath: string;
    sessionAudioDir: string;
    sessionTempDir: string;
}

export interface BatchProjectOutputPaths extends SingleProjectOutputPaths {}

function resolveOutputDir(paths: DesktopProjectPaths, outputDirOverride?: string) {
    return outputDirOverride?.trim() || paths.outputDir;
}

function buildSessionCacheRoot(outputDir: string) {
    return `${outputDir}\\.videosync-cache\\sessions`;
}

export function getFileNameFromPath(filePath: string, fallback = 'video.mp4') {
    return filePath.split(/[\\/]/).pop() || fallback;
}

export function buildSingleOutputPaths(
    paths: DesktopProjectPaths,
    fileName: string,
    outputDirOverride?: string,
    artifactLanguages: SubtitleArtifactLanguages = {}
): SingleProjectOutputPaths {
    const baseName = sanitizeBaseName(fileName);
    const sessionKey = buildSessionKey(fileName);
    const outputDir = resolveOutputDir(paths, outputDirOverride);
    const finalDir = `${outputDir}\\${sessionKey}`;
    const sessionCacheDir = `${buildSessionCacheRoot(outputDir)}\\single\\${sessionKey}`;
    const sourceLangTag = artifactLanguages.sourceLangTag || 'und';
    const targetLangTag = artifactLanguages.targetLangTag || 'und';
    const subtitlePaths = buildSubtitleArtifactPaths(finalDir, baseName, sourceLangTag, targetLangTag);

    return {
        baseName,
        sessionKey,
        outputDir,
        finalDir,
        finalVideoPath: `${finalDir}\\${fileName}`,
        originalSubtitlePath: subtitlePaths.originalSubtitlePath,
        translatedSubtitlePath: subtitlePaths.translatedSubtitlePath,
        sessionCacheDir,
        sessionManifestPath: `${sessionCacheDir}\\session-manifest.json`,
        sessionAudioDir: `${sessionCacheDir}\\audio`,
        sessionTempDir: `${sessionCacheDir}\\temp`
    };
}

export function buildBatchOutputPaths(
    paths: DesktopProjectPaths,
    fileName: string,
    itemId: string,
    outputDirOverride?: string,
    artifactLanguages: SubtitleArtifactLanguages = {}
): BatchProjectOutputPaths {
    const baseName = sanitizeBaseName(fileName);
    const sessionKey = `${buildSessionKey(fileName)}_${itemId.slice(-4)}`;
    const outputDir = resolveOutputDir(paths, outputDirOverride);
    const finalDir = `${outputDir}\\${sessionKey}`;
    const sessionCacheDir = `${buildSessionCacheRoot(outputDir)}\\batch\\${sessionKey}`;
    const sourceLangTag = artifactLanguages.sourceLangTag || 'und';
    const targetLangTag = artifactLanguages.targetLangTag || 'und';
    const subtitlePaths = buildSubtitleArtifactPaths(finalDir, baseName, sourceLangTag, targetLangTag);

    return {
        baseName,
        sessionKey,
        outputDir,
        finalDir,
        finalVideoPath: `${finalDir}\\${fileName}`,
        originalSubtitlePath: subtitlePaths.originalSubtitlePath,
        translatedSubtitlePath: subtitlePaths.translatedSubtitlePath,
        sessionCacheDir,
        sessionManifestPath: `${sessionCacheDir}\\session-manifest.json`,
        sessionAudioDir: `${sessionCacheDir}\\audio`,
        sessionTempDir: `${sessionCacheDir}\\temp`
    };
}

export async function prepareSingleProjectPaths(
    filePath: string,
    outputDirOverride?: string,
    artifactLanguages: SubtitleArtifactLanguages = {}
) {
    const paths = await window.api.getPaths();
    const fileName = getFileNameFromPath(filePath);
    const projectPaths = buildSingleOutputPaths(paths, fileName, outputDirOverride, artifactLanguages);
    await Promise.all([
        window.api.ensureDir(projectPaths.finalDir),
        window.api.ensureDir(projectPaths.sessionCacheDir),
        window.api.ensureDir(projectPaths.sessionAudioDir),
        window.api.ensureDir(projectPaths.sessionTempDir)
    ]);
    return { fileName, paths, projectPaths };
}

export async function prepareBatchProjectPaths(
    fileName: string,
    itemId: string,
    outputDirOverride?: string,
    artifactLanguages: SubtitleArtifactLanguages = {}
) {
    const paths = await window.api.getPaths();
    const projectPaths = buildBatchOutputPaths(paths, fileName, itemId, outputDirOverride, artifactLanguages);
    await Promise.all([
        window.api.ensureDir(projectPaths.finalDir),
        window.api.ensureDir(projectPaths.sessionCacheDir),
        window.api.ensureDir(projectPaths.sessionAudioDir),
        window.api.ensureDir(projectPaths.sessionTempDir)
    ]);
    return { paths, projectPaths };
}

export async function preparePreviewCacheFile(fileName: string) {
    const paths = await window.api.getPaths();
    const previewDir = `${paths.cacheDir}\\previews`;
    await window.api.ensureDir(previewDir);
    return {
        paths,
        previewDir,
        outputPath: `${previewDir}\\${fileName}`
    };
}
