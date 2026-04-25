import { logUiError } from './frontendLogger';

interface SessionManifestArtifacts {
    sessionCacheDir: string;
    sessionAudioDir: string;
    sessionTempDir: string;
    finalDir?: string;
    finalVideoPath?: string;
    originalSubtitlePath?: string;
    translatedSubtitlePath?: string;
}

interface SessionManifestResume {
    recoverable: boolean;
    preservedAudioSegments?: string[];
    lastMode?: 'success' | 'failed' | 'interrupted';
}

interface SessionManifestError {
    code?: string;
    message: string;
    stage?: string;
    retryable?: boolean;
    detail?: string;
}

export interface SessionManifest {
    version: 1;
    updatedAt: string;
    sessionKey?: string;
    fileName?: string;
    sourcePath?: string;
    phase:
        | 'initialized'
        | 'preparing'
        | 'source_subtitles_ready'
        | 'translated_subtitles_ready'
        | 'dubbing'
        | 'merging'
        | 'completed'
        | 'failed'
        | 'interrupted';
    currentStage?: string;
    outputDir?: string;
    artifacts: SessionManifestArtifacts;
    resume: SessionManifestResume;
    lastError?: SessionManifestError;
}

export interface SessionResumePlan {
    isRecoverable: boolean;
    resumeBlocked: boolean;
    canReuseSourceSubtitles: boolean;
    canReuseTranslatedSubtitles: boolean;
    canResumeDubbing: boolean;
    canResumeMerge: boolean;
    preservedAudioSegments: string[];
    sourceSubtitlePath?: string;
    translatedSubtitlePath?: string;
    blockedReason?: string;
}

type ManifestPatch = Partial<Omit<SessionManifest, 'version' | 'updatedAt' | 'artifacts' | 'resume' | 'lastError'>> & {
    artifacts?: Partial<SessionManifestArtifacts>;
    resume?: Partial<SessionManifestResume>;
    lastError?: SessionManifestError | null;
};

interface SessionManifestTarget {
    sessionCacheDir: string;
    sessionManifestPath?: string;
}

export function resolveSessionManifestPath(target: SessionManifestTarget) {
    return target.sessionManifestPath || `${target.sessionCacheDir}\\session-manifest.json`;
}

const PHASE_ORDER: Record<SessionManifest['phase'], number> = {
    initialized: 0,
    preparing: 1,
    source_subtitles_ready: 2,
    translated_subtitles_ready: 3,
    dubbing: 4,
    merging: 5,
    completed: 6,
    failed: 7,
    interrupted: 8
};

function hasReachedPhase(
    manifest: SessionManifest,
    phase: 'source_subtitles_ready' | 'translated_subtitles_ready' | 'dubbing' | 'merging'
) {
    return PHASE_ORDER[manifest.phase] >= PHASE_ORDER[phase];
}

async function filterExistingPaths(paths: string[] = []) {
    const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
    const checks = await Promise.all(uniquePaths.map(async (targetPath) => ({
        targetPath,
        exists: await window.api.checkFileExists(targetPath)
    })));
    return checks.filter(item => item.exists).map(item => item.targetPath);
}

export async function getSessionResumePlan(
    manifest: SessionManifest | null,
    target: {
        originalSubtitlePath: string;
        translatedSubtitlePath: string;
        sessionAudioDir: string;
    }
): Promise<SessionResumePlan> {
    if (!manifest) {
        return {
            isRecoverable: false,
            resumeBlocked: false,
            canReuseSourceSubtitles: false,
            canReuseTranslatedSubtitles: false,
            canResumeDubbing: false,
            canResumeMerge: false,
            preservedAudioSegments: []
        };
    }

    const sourceSubtitlePath = manifest.artifacts.originalSubtitlePath || target.originalSubtitlePath;
    const translatedSubtitlePath = manifest.artifacts.translatedSubtitlePath || target.translatedSubtitlePath;
    const [existingSourceSubtitles, existingTranslatedSubtitles, preservedAudioSegments] = await Promise.all([
        filterExistingPaths([sourceSubtitlePath]),
        filterExistingPaths([translatedSubtitlePath]),
        filterExistingPaths(manifest.resume.preservedAudioSegments || [])
    ]);

    const resumeBlocked = manifest.phase === 'completed' && manifest.resume.recoverable !== true
        ? true
        : manifest.lastError?.retryable === false;

    return {
        isRecoverable: manifest.resume.recoverable === true && !resumeBlocked,
        resumeBlocked,
        canReuseSourceSubtitles: hasReachedPhase(manifest, 'source_subtitles_ready') && existingSourceSubtitles.length > 0,
        canReuseTranslatedSubtitles: hasReachedPhase(manifest, 'translated_subtitles_ready') && existingTranslatedSubtitles.length > 0,
        canResumeDubbing: manifest.resume.recoverable === true && (
            hasReachedPhase(manifest, 'dubbing') || preservedAudioSegments.length > 0
        ),
        canResumeMerge: manifest.resume.recoverable === true
            && hasReachedPhase(manifest, 'merging')
            && existingTranslatedSubtitles.length > 0
            && preservedAudioSegments.length > 0,
        preservedAudioSegments,
        sourceSubtitlePath: existingSourceSubtitles[0],
        translatedSubtitlePath: existingTranslatedSubtitles[0],
        blockedReason: manifest.lastError?.retryable === false
            ? 'terminal-error'
            : (manifest.phase === 'completed' && manifest.resume.recoverable !== true ? 'already-completed' : undefined)
    };
}

export async function readSessionManifest(target: SessionManifestTarget): Promise<SessionManifest | null> {
    const manifestPath = resolveSessionManifestPath(target);
    const exists = await window.api.checkFileExists(manifestPath);
    if (!exists) {
        return null;
    }

    try {
        const raw = await window.api.readFile(manifestPath);
        if (!raw) {
            return null;
        }
        return JSON.parse(raw) as SessionManifest;
    } catch (error) {
        logUiError('读取会话清单失败', {
            domain: 'session.manifest',
            action: 'readSessionManifest',
            detail: `${manifestPath} ${error instanceof Error ? error.message : String(error)}`
        });
        return null;
    }
}

export async function writeSessionManifest(target: SessionManifestTarget, manifest: SessionManifest) {
    const manifestPath = resolveSessionManifestPath(target);
    await window.api.saveFile(manifestPath, JSON.stringify(manifest, null, 2));
}

export async function initializeSessionManifest(
    target: SessionManifestTarget,
    manifest: Omit<SessionManifest, 'version' | 'updatedAt'>
) {
    await writeSessionManifest(target, {
        version: 1,
        updatedAt: new Date().toISOString(),
        ...manifest
    });
}

export async function updateSessionManifest(target: SessionManifestTarget, patch: ManifestPatch) {
    const manifestPath = resolveSessionManifestPath(target);
    const current = await readSessionManifest({ sessionCacheDir: target.sessionCacheDir, sessionManifestPath: manifestPath });

    const next: SessionManifest = {
        version: 1,
        updatedAt: new Date().toISOString(),
        sessionKey: current?.sessionKey,
        fileName: current?.fileName,
        sourcePath: current?.sourcePath,
        phase: current?.phase || 'initialized',
        currentStage: current?.currentStage,
        outputDir: current?.outputDir,
        artifacts: {
            sessionCacheDir: target.sessionCacheDir,
            sessionAudioDir: current?.artifacts.sessionAudioDir || `${target.sessionCacheDir}\\audio`,
            sessionTempDir: current?.artifacts.sessionTempDir || `${target.sessionCacheDir}\\temp`,
            finalDir: current?.artifacts.finalDir,
            finalVideoPath: current?.artifacts.finalVideoPath,
            originalSubtitlePath: current?.artifacts.originalSubtitlePath,
            translatedSubtitlePath: current?.artifacts.translatedSubtitlePath
        },
        resume: {
            recoverable: current?.resume.recoverable ?? false,
            preservedAudioSegments: current?.resume.preservedAudioSegments,
            lastMode: current?.resume.lastMode
        },
        lastError: current?.lastError
    };

    Object.assign(next, patch);
    if (patch.artifacts) {
        next.artifacts = {
            ...next.artifacts,
            ...patch.artifacts
        };
    }
    if (patch.resume) {
        next.resume = {
            ...next.resume,
            ...patch.resume
        };
    }
    if (patch.lastError !== undefined) {
        next.lastError = patch.lastError || undefined;
    }

    await writeSessionManifest({ sessionCacheDir: target.sessionCacheDir, sessionManifestPath: manifestPath }, next);
}

export async function listResumeAudioSegments(sessionAudioDir: string) {
    const results: string[] = [];
    let index = 0;
    while (index < 5000) {
        const segmentPath = `${sessionAudioDir}\\segment_${index}.wav`;
        const retryPath = `${sessionAudioDir}\\segment_retry_${index}.wav`;
        const [segmentExists, retryExists] = await Promise.all([
            window.api.checkFileExists(segmentPath),
            window.api.checkFileExists(retryPath)
        ]);

        if (!segmentExists && !retryExists && index > 128) {
            break;
        }
        if (segmentExists) results.push(segmentPath);
        if (retryExists) results.push(retryPath);
        index += 1;
    }
    return results;
}
