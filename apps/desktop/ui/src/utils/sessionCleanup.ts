import { cleanupOutputArtifacts } from './outputArtifacts';
import { logUiError } from './frontendLogger';
import { listResumeAudioSegments, updateSessionManifest } from './sessionManifest';

interface SessionCleanupPaths {
    sessionCacheDir: string;
    sessionManifestPath?: string;
    sessionAudioDir?: string;
    finalDir?: string;
}

type SessionCleanupMode = 'success' | 'failed' | 'interrupted';

export async function cleanupSessionArtifacts(
    paths: SessionCleanupPaths,
    mode: SessionCleanupMode,
    extraPaths: string[] = []
) {
    const normalizedExtraPaths = extraPaths.filter((targetPath): targetPath is string => Boolean(targetPath));
    const cleanupTargets = [...normalizedExtraPaths];

    if (mode === 'success' && paths?.finalDir) {
        cleanupTargets.push(`${paths.finalDir}\\.cache`);
    }

    if (cleanupTargets.length > 0) {
        await cleanupOutputArtifacts('', cleanupTargets);
    }

    if (!paths?.sessionCacheDir) {
        return;
    }

    const resumeSegments = paths.sessionAudioDir
        ? await listResumeAudioSegments(paths.sessionAudioDir)
        : [];

    await updateSessionManifest(paths, {
        phase: mode === 'success' ? 'completed' : mode,
        currentStage: mode === 'success' ? '清理完成前归档' : '保留断点恢复文件',
        resume: {
            recoverable: mode !== 'success' && resumeSegments.length > 0,
            preservedAudioSegments: resumeSegments,
            lastMode: mode
        },
        lastError: mode === 'success' ? null : undefined
    }).catch((error) => {
        logUiError('清理前更新会话清单失败', {
            domain: 'session.cleanup',
            action: 'cleanupSessionArtifacts',
            detail: error instanceof Error ? error.message : String(error)
        });
    });

    await window.api.cleanupSessionCache({
        sessionCacheDir: paths.sessionCacheDir,
        mode
    });
}
