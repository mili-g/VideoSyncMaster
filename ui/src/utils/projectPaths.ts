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
    outputDirOverride?: string
): SingleProjectOutputPaths {
    const baseName = sanitizeBaseName(fileName);
    const sessionKey = buildSessionKey(fileName);
    const outputDir = resolveOutputDir(paths, outputDirOverride);
    const finalDir = `${outputDir}\\${sessionKey}`;
    const sessionCacheDir = `${buildSessionCacheRoot(outputDir)}\\single\\${sessionKey}`;

    return {
        baseName,
        sessionKey,
        outputDir,
        finalDir,
        finalVideoPath: `${finalDir}\\${fileName}`,
        originalSubtitlePath: `${finalDir}\\${baseName}.en.srt`,
        translatedSubtitlePath: `${finalDir}\\${baseName}.zh-CN.srt`,
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
    outputDirOverride?: string
): BatchProjectOutputPaths {
    const baseName = sanitizeBaseName(fileName);
    const sessionKey = `${buildSessionKey(fileName)}_${itemId.slice(-4)}`;
    const outputDir = resolveOutputDir(paths, outputDirOverride);
    const finalDir = `${outputDir}\\${sessionKey}`;
    const sessionCacheDir = `${buildSessionCacheRoot(outputDir)}\\batch\\${sessionKey}`;

    return {
        baseName,
        sessionKey,
        outputDir,
        finalDir,
        finalVideoPath: `${finalDir}\\${fileName}`,
        originalSubtitlePath: `${finalDir}\\${baseName}.en.srt`,
        translatedSubtitlePath: `${finalDir}\\${baseName}.zh-CN.srt`,
        sessionCacheDir,
        sessionManifestPath: `${sessionCacheDir}\\session-manifest.json`,
        sessionAudioDir: `${sessionCacheDir}\\audio`,
        sessionTempDir: `${sessionCacheDir}\\temp`
    };
}

export async function prepareSingleProjectPaths(filePath: string, outputDirOverride?: string) {
    const paths = await window.api.getPaths();
    const fileName = getFileNameFromPath(filePath);
    const projectPaths = buildSingleOutputPaths(paths, fileName, outputDirOverride);
    await Promise.all([
        window.api.ensureDir(projectPaths.finalDir),
        window.api.ensureDir(projectPaths.sessionCacheDir),
        window.api.ensureDir(projectPaths.sessionAudioDir),
        window.api.ensureDir(projectPaths.sessionTempDir)
    ]);
    return { fileName, paths, projectPaths };
}

export async function prepareBatchProjectPaths(fileName: string, itemId: string, outputDirOverride?: string) {
    const paths = await window.api.getPaths();
    const projectPaths = buildBatchOutputPaths(paths, fileName, itemId, outputDirOverride);
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
