function sanitizeBaseName(fileName: string) {
    return fileName.replace(/\.[^/.]+$/, '');
}

function sanitizePathSegment(value: string) {
    return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'untitled';
}

function buildSessionKey(fileName: string) {
    return sanitizePathSegment(sanitizeBaseName(fileName));
}

export interface DesktopProjectPaths {
    projectRoot: string;
    outputDir: string;
    cacheDir: string;
}

function resolveOutputDir(paths: DesktopProjectPaths, outputDirOverride?: string) {
    return outputDirOverride?.trim() || paths.outputDir;
}

export function buildSingleOutputPaths(paths: DesktopProjectPaths, fileName: string, outputDirOverride?: string) {
    const baseName = sanitizeBaseName(fileName);
    const sessionKey = buildSessionKey(fileName);
    const outputDir = resolveOutputDir(paths, outputDirOverride);
    const finalDir = `${outputDir}\\${sessionKey}`;
    const sessionCacheDir = `${paths.cacheDir}\\sessions\\single\\${sessionKey}`;

    return {
        baseName,
        sessionKey,
        finalDir,
        finalVideoPath: `${finalDir}\\${fileName}`,
        originalSubtitlePath: `${finalDir}\\${baseName}.original.srt`,
        translatedSubtitlePath: `${finalDir}\\${baseName}.en.srt`,
        sessionCacheDir,
        sessionAudioDir: `${sessionCacheDir}\\audio`,
        sessionTempDir: `${sessionCacheDir}\\temp`
    };
}

export function buildBatchOutputPaths(paths: DesktopProjectPaths, fileName: string, itemId: string, outputDirOverride?: string) {
    const baseName = sanitizeBaseName(fileName);
    const sessionKey = `${buildSessionKey(fileName)}_${itemId.slice(-4)}`;
    const outputDir = resolveOutputDir(paths, outputDirOverride);
    const finalDir = `${outputDir}\\${sessionKey}`;
    const sessionCacheDir = `${paths.cacheDir}\\sessions\\batch\\${sessionKey}`;

    return {
        baseName,
        sessionKey,
        finalDir,
        finalVideoPath: `${finalDir}\\${fileName}`,
        originalSubtitlePath: `${finalDir}\\${baseName}.original.srt`,
        translatedSubtitlePath: `${finalDir}\\${baseName}.en.srt`,
        sessionCacheDir,
        sessionAudioDir: `${sessionCacheDir}\\audio`,
        sessionTempDir: `${sessionCacheDir}\\temp`
    };
}
