import { saveOriginalSubtitleArtifact, saveSubtitleArtifacts } from './outputArtifacts';
import { prepareSingleProjectPaths } from './projectPaths';
import { resolveSubtitleArtifactLanguages } from './languageTags';
import { initializeSessionManifest, readSessionManifest, updateSessionManifest } from './sessionManifest';
import type { Segment } from '../hooks/useVideoProject';

export async function persistSingleSubtitleArtifacts(options: {
    originalVideoPath: string;
    outputDirOverride?: string;
    asrOriLang: string;
    targetLang: string;
    sourceSegments: Segment[];
    translatedSegments: Segment[];
}) {
    const {
        originalVideoPath,
        outputDirOverride,
        asrOriLang,
        targetLang,
        sourceSegments,
        translatedSegments
    } = options;

    if (!originalVideoPath || sourceSegments.length === 0) {
        return;
    }

    const artifactLanguages = resolveSubtitleArtifactLanguages(asrOriLang, targetLang);
    const { fileName, projectPaths } = await prepareSingleProjectPaths(
        originalVideoPath,
        outputDirOverride,
        artifactLanguages
    );

    const normalizedSourceSegments = sourceSegments.map(segment => ({
        start: segment.start,
        end: segment.end,
        text: segment.text
    }));
    const normalizedTranslatedSegments = translatedSegments.map(segment => ({
        start: segment.start,
        end: segment.end,
        text: segment.text
    }));

    if (normalizedTranslatedSegments.length > 0) {
        await saveSubtitleArtifacts(
            projectPaths.finalDir,
            fileName,
            normalizedSourceSegments,
            normalizedTranslatedSegments,
            artifactLanguages
        );
    } else {
        await saveOriginalSubtitleArtifact(
            projectPaths.finalDir,
            fileName,
            normalizedSourceSegments,
            artifactLanguages
        );
    }

    await ensureSingleSubtitleManifest({
        originalVideoPath,
        asrOriLang,
        targetLang,
        fileName,
        projectPaths,
        hasTranslatedSubtitles: normalizedTranslatedSegments.length > 0
    });
}

async function ensureSingleSubtitleManifest(options: {
    originalVideoPath: string;
    asrOriLang: string;
    targetLang: string;
    fileName: string;
    projectPaths: Awaited<ReturnType<typeof prepareSingleProjectPaths>>['projectPaths'];
    hasTranslatedSubtitles: boolean;
}) {
    const {
        originalVideoPath,
        fileName,
        projectPaths,
        hasTranslatedSubtitles
    } = options;

    const phase = hasTranslatedSubtitles ? 'translated_subtitles_ready' : 'source_subtitles_ready';
    const currentStage = hasTranslatedSubtitles ? '字幕已实时保存' : '原字幕已实时保存';

    const existingManifest = await readSessionManifest(projectPaths);
    const patch = {
        sessionKey: projectPaths.sessionKey,
        fileName,
        sourcePath: originalVideoPath,
        phase,
        currentStage,
        outputDir: projectPaths.outputDir,
        artifacts: {
            sessionCacheDir: projectPaths.sessionCacheDir,
            sessionAudioDir: projectPaths.sessionAudioDir,
            sessionTempDir: projectPaths.sessionTempDir,
            finalDir: projectPaths.finalDir,
            finalVideoPath: projectPaths.finalVideoPath,
            originalSubtitlePath: projectPaths.originalSubtitlePath,
            translatedSubtitlePath: projectPaths.translatedSubtitlePath
        },
        resume: {
            recoverable: false
        },
        lastError: null
    } as const;

    if (existingManifest) {
        await updateSessionManifest(projectPaths, patch);
        return;
    }

    await initializeSessionManifest(projectPaths, {
        sessionKey: patch.sessionKey,
        fileName: patch.fileName,
        sourcePath: patch.sourcePath,
        phase: patch.phase,
        currentStage: patch.currentStage,
        outputDir: patch.outputDir,
        artifacts: patch.artifacts,
        resume: {
            recoverable: false,
            preservedAudioSegments: []
        },
        lastError: undefined
    });
}
