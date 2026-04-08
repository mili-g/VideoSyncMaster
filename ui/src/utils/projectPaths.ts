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

export function buildSingleOutputPaths(paths: DesktopProjectPaths, fileName: string) {
    const baseName = sanitizeBaseName(fileName);
    const sessionKey = buildSessionKey(fileName);
    const finalDir = `${paths.outputDir}\\${sessionKey}`;
    const sessionCacheDir = `${paths.cacheDir}\\sessions\\single\\${sessionKey}`;

    return {
        baseName,
        sessionKey,
        finalDir,
        finalVideoPath: `${finalDir}\\${fileName}`,
        originalSubtitlePath: `${finalDir}\\${baseName}.original.srt`,
        translatedSubtitlePath: `${finalDir}\\${baseName}.zh-CN.srt`,
        sessionCacheDir,
        sessionAudioDir: `${sessionCacheDir}\\audio`,
        sessionTempDir: `${sessionCacheDir}\\temp`
    };
}

export function buildBatchOutputPaths(paths: DesktopProjectPaths, fileName: string, itemId: string) {
    const baseName = sanitizeBaseName(fileName);
    const sessionKey = `${buildSessionKey(fileName)}_${itemId.slice(-4)}`;
    const finalDir = `${paths.outputDir}\\${sessionKey}`;
    const sessionCacheDir = `${paths.cacheDir}\\sessions\\batch\\${sessionKey}`;

    return {
        baseName,
        sessionKey,
        finalDir,
        finalVideoPath: `${finalDir}\\${fileName}`,
        originalSubtitlePath: `${finalDir}\\${baseName}.original.srt`,
        translatedSubtitlePath: `${finalDir}\\${baseName}.zh-CN.srt`,
        sessionCacheDir,
        sessionAudioDir: `${sessionCacheDir}\\audio`,
        sessionTempDir: `${sessionCacheDir}\\temp`
    };
}
