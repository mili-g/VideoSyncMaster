import type { Segment } from '../hooks/useVideoProject';
import type { BackendAction } from './backendCommands';

export interface BackendResponseBase {
    success: boolean;
    error?: string;
    error_info?: {
        code?: string;
        message?: string;
        category?: string;
        stage?: string;
        retryable?: boolean;
        detail?: string;
        suggestion?: string;
    };
}

export interface TranslateTextResponse extends BackendResponseBase {
    text?: string;
    segments?: Segment[];
}

export interface BatchTtsResultItem {
    index?: number;
    original_index?: number;
    success?: boolean;
    audio_path?: string;
    duration?: number;
    error?: string;
}

export interface SingleTtsResponse extends BackendResponseBase {
    audio_path?: string;
    duration?: number;
}

export interface BatchTtsResponse extends BackendResponseBase {
    results?: BatchTtsResultItem[];
}

export interface MergeVideoResponse extends BackendResponseBase {
    output?: string;
    messages?: string[];
    segments?: Array<Segment & {
        path?: string;
        timeline_start?: number;
        timeline_duration?: number;
    }>;
}

export interface PrepareReferenceAudioResponse extends BackendResponseBase {
    ref_audio_path?: string;
    meta?: {
        text?: string;
    };
}

export interface AudioDurationCheckResponse extends BackendResponseBase {
    durations?: Record<string, number>;
}

export interface AnalyzeVideoMetadataResponse extends BackendResponseBase {
    duration?: number;
    width?: number;
    height?: number;
    fps?: number;
    sample_rate?: number;
    channels?: number;
    info?: {
        duration?: number;
        video_codec?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface PythonEnvCheckResponse extends BackendResponseBase {
    status?: string;
    missing?: string[];
}

export interface StatusDetail {
    installed?: boolean;
    state: string;
    detail: string;
    repairable?: boolean;
}

export interface ModelStatusResponse extends BackendResponseBase {
    status?: Record<string, boolean>;
    status_details?: Record<string, StatusDetail>;
    root?: string;
}

export interface ModelRootSettingsResponse extends BackendResponseBase {
    root?: string;
    defaultRoot?: string;
    managedRoot?: string;
    configuredRoot?: string | null;
    usingCustomRoot?: boolean;
    protectedDefaultRoot?: boolean;
}

export interface RuntimeRootSettingsResponse extends BackendResponseBase {
    root?: string;
    defaultRoot?: string;
    managedRoot?: string;
    configuredRoot?: string | null;
    usingCustomRoot?: boolean;
    protectedDefaultRoot?: boolean;
}

export interface ModelDownloadProgressEvent {
    key: string;
    active?: boolean;
    percent?: number;
    phase?: 'preparing' | 'downloading' | 'extracting' | 'installing' | 'completed' | 'failed' | 'canceled';
    message?: string;
}

export interface DownloadTaskSnapshotsResponse extends BackendResponseBase {
    tasks?: ModelDownloadProgressEvent[];
}

export interface AsrDiagnosticsCheck {
    service: string;
    ok: boolean;
    state: string;
    stage: string;
    detail: string;
}

export interface AsrDiagnosticsProbe {
    service: string;
    ok: boolean;
    state: string;
    detail: string;
    segment_count: number;
}

export interface AsrDiagnosticsResponse extends BackendResponseBase {
    probe_audio_path?: string;
    checks?: AsrDiagnosticsCheck[];
    probes?: AsrDiagnosticsProbe[];
    failed_checks?: string[];
    failed_probes?: string[];
}

export interface TtsRuntimeDiagnosticsPayload {
    service?: string;
    runtime_ok?: boolean;
    snapshot?: {
        free_gb?: number;
        total_gb?: number;
    } | null;
    tier?: string;
    model_profile?: string;
    adaptive_batch?: number;
    adaptive_batch_detail?: {
        free_gb?: number;
        total_gb?: number;
        requested_batch_size?: number;
        adaptive_batch_size?: number;
    } | null;
    effective_single?: Record<string, number | string | boolean>;
    effective_batch?: Record<string, number | string | boolean>;
    official_fast_mode?: boolean;
}

export interface TtsRuntimeDiagnosticsResponse extends BackendResponseBase {
    service?: string;
    diagnostics?: TtsRuntimeDiagnosticsPayload;
}

export interface FileDialogResult {
    canceled: boolean;
    filePaths?: string[];
    filePath?: string;
}

export type BackendCommandResponseMap = {
    analyze_video: AnalyzeVideoMetadataResponse;
    check_audio_files: AudioDurationCheckResponse;
    dub_video: BackendResponseBase;
    generate_batch_tts: BatchTtsResponse | BackendResponseBase;
    generate_single_tts: SingleTtsResponse;
    merge_video: MergeVideoResponse;
    prepare_reference_audio: PrepareReferenceAudioResponse;
    test_align: BackendResponseBase;
    test_asr: Segment[] | BackendResponseBase;
    test_tts: BackendResponseBase;
    transcode_video: BackendResponseBase;
    translate_text: TranslateTextResponse;
    warmup_tts_runtime: BackendResponseBase;
    switch_runtime_profile: BackendResponseBase;
};

export type BackendCommandResponse<Action extends BackendAction> = BackendCommandResponseMap[Action];
