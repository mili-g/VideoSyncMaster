import { BACKEND_ACTIONS, withBackendAction } from '../types/backendCommands';
import type { BackendCommandSpec } from './backendCommandClient';

interface TranslateTextCommandOptions {
    input: string;
    targetLang: string;
    json?: boolean;
}

interface TestAsrCommandOptions {
    input: string;
    asrService: string;
    asrModelProfile: string;
    outputDir: string;
    sourceLanguage?: string;
    json?: boolean;
}

interface WarmupTtsRuntimeCommandOptions {
    ttsService: string;
    ttsModelProfile: string;
    json?: boolean;
}

interface SwitchRuntimeProfileCommandOptions {
    runtimeProfile: string;
    json?: boolean;
    ttsService?: string;
    asrService?: string;
}

interface PrepareReferenceAudioCommandOptions {
    input: string;
    ref: string;
    output: string;
    json?: boolean;
}

interface MergeVideoCommandOptions {
    input: string;
    output: string;
    ref: string;
    strategy: string;
    audioMixMode: string;
    json?: boolean;
}

interface TestTtsCommandOptions {
    input: string;
    output: string;
    ttsService: string;
    ttsModelProfile: string;
    language: string;
    json?: boolean;
    ref?: string;
    qwenMode?: string;
    qwenRefText?: string;
    voiceInstruct?: string;
    presetVoice?: string;
}

export function buildTranslateTextCommand({
    input,
    targetLang,
    json = true
}: TranslateTextCommandOptions): BackendCommandSpec<typeof BACKEND_ACTIONS.TRANSLATE_TEXT> {
    const args = withBackendAction(
        BACKEND_ACTIONS.TRANSLATE_TEXT,
        '--input', input,
        '--lang', targetLang
    );
    if (json) args.push('--json');
    return { action: BACKEND_ACTIONS.TRANSLATE_TEXT, args };
}

export function buildTestAsrCommand({
    input,
    asrService,
    asrModelProfile,
    outputDir,
    sourceLanguage,
    json = false
}: TestAsrCommandOptions): BackendCommandSpec<typeof BACKEND_ACTIONS.TEST_ASR> {
    const args = withBackendAction(
        BACKEND_ACTIONS.TEST_ASR,
        '--input', input,
        '--asr', asrService,
        '--asr_model_profile', asrModelProfile,
        '--output_dir', outputDir
    );
    if (sourceLanguage !== undefined) {
        args.push('--ori_lang', sourceLanguage);
    }
    if (json) args.push('--json');
    return { action: BACKEND_ACTIONS.TEST_ASR, args };
}

export function buildWarmupTtsRuntimeCommand({
    ttsService,
    ttsModelProfile,
    json = true
}: WarmupTtsRuntimeCommandOptions): BackendCommandSpec<typeof BACKEND_ACTIONS.WARMUP_TTS_RUNTIME> {
    const args = withBackendAction(
        BACKEND_ACTIONS.WARMUP_TTS_RUNTIME,
        '--tts_service', ttsService,
        '--tts_model_profile', ttsModelProfile
    );
    if (json) args.push('--json');
    return { action: BACKEND_ACTIONS.WARMUP_TTS_RUNTIME, args };
}

export function buildSwitchRuntimeProfileCommand({
    runtimeProfile,
    json = true,
    ttsService,
    asrService
}: SwitchRuntimeProfileCommandOptions): BackendCommandSpec<typeof BACKEND_ACTIONS.SWITCH_RUNTIME_PROFILE> {
    const args = withBackendAction(
        BACKEND_ACTIONS.SWITCH_RUNTIME_PROFILE,
        '--runtime_profile', runtimeProfile
    );
    if (ttsService) args.push('--tts_service', ttsService);
    if (asrService) args.push('--asr', asrService);
    if (json) args.push('--json');
    return { action: BACKEND_ACTIONS.SWITCH_RUNTIME_PROFILE, args };
}

export function buildPrepareReferenceAudioCommand({
    input,
    ref,
    output,
    json = true
}: PrepareReferenceAudioCommandOptions): BackendCommandSpec<typeof BACKEND_ACTIONS.PREPARE_REFERENCE_AUDIO> {
    const args = withBackendAction(
        BACKEND_ACTIONS.PREPARE_REFERENCE_AUDIO,
        '--input', input,
        '--ref', ref,
        '--output', output
    );
    if (json) args.push('--json');
    return { action: BACKEND_ACTIONS.PREPARE_REFERENCE_AUDIO, args };
}

export function buildMergeVideoCommand({
    input,
    output,
    ref,
    strategy,
    audioMixMode,
    json = false
}: MergeVideoCommandOptions): BackendCommandSpec<typeof BACKEND_ACTIONS.MERGE_VIDEO> {
    const args = withBackendAction(
        BACKEND_ACTIONS.MERGE_VIDEO,
        '--input', input,
        '--output', output,
        '--ref', ref,
        '--strategy', strategy,
        '--audio_mix_mode', audioMixMode
    );
    if (json) args.push('--json');
    return { action: BACKEND_ACTIONS.MERGE_VIDEO, args };
}

export function buildCheckAudioFilesCommand(input: string): BackendCommandSpec<typeof BACKEND_ACTIONS.CHECK_AUDIO_FILES> {
    return {
        action: BACKEND_ACTIONS.CHECK_AUDIO_FILES,
        args: withBackendAction(
        BACKEND_ACTIONS.CHECK_AUDIO_FILES,
        '--input', input
        )
    };
}

export function buildTranscodeVideoCommand(input: string, output: string): BackendCommandSpec<typeof BACKEND_ACTIONS.TRANSCODE_VIDEO> {
    return {
        action: BACKEND_ACTIONS.TRANSCODE_VIDEO,
        args: withBackendAction(
        BACKEND_ACTIONS.TRANSCODE_VIDEO,
        '--input', input,
        '--output', output
        )
    };
}

export function buildTestTtsCommand({
    input,
    output,
    ttsService,
    ttsModelProfile,
    language,
    json = true,
    ref,
    qwenMode,
    qwenRefText,
    voiceInstruct,
    presetVoice
}: TestTtsCommandOptions): BackendCommandSpec<typeof BACKEND_ACTIONS.TEST_TTS> {
    const args = withBackendAction(
        BACKEND_ACTIONS.TEST_TTS,
        '--input', input,
        '--output', output,
        '--tts_service', ttsService,
        '--tts_model_profile', ttsModelProfile,
        '--lang', language
    );
    if (json) args.push('--json');
    if (ref) args.push('--ref', ref);
    if (qwenMode) args.push('--qwen_mode', qwenMode);
    if (qwenRefText) args.push('--qwen_ref_text', qwenRefText);
    if (voiceInstruct) args.push('--voice_instruct', voiceInstruct);
    if (presetVoice) args.push('--preset_voice', presetVoice);
    return { action: BACKEND_ACTIONS.TEST_TTS, args };
}
