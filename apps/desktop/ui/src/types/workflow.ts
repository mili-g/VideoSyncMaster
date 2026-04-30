export interface BackendEventContext {
    trace_id?: string;
    request_id?: string;
    parent_trace_id?: string;
    action?: string;
}

export type WorkflowStepStatus = 'idle' | 'ready' | 'active' | 'done' | 'blocked' | 'error';

export interface WorkflowStepState {
    key: 'video' | 'asr' | 'translation' | 'dubbing' | 'merge';
    label: string;
    status: WorkflowStepStatus;
    detail: string;
}

export interface WorkflowInsight {
    label: string;
    value: string;
    tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}

export interface WorkflowOverviewModel {
    phase: 'idle' | 'ready' | 'running' | 'attention' | 'completed';
    activeStepKey: WorkflowStepState['key'];
    headline: string;
    recommendation: string;
    sourceCount: number;
    translatedCount: number;
    dubbedReadyCount: number;
    dubbedErrorCount: number;
    blockers: string[];
    insights: WorkflowInsight[];
    latestIssue?: {
        title: string;
        traceId?: string;
        category?: string;
    };
    steps: WorkflowStepState[];
}

export interface StructuredErrorInfo {
    code?: string;
    message: string;
    category?: string;
    stage?: string;
    retryable?: boolean;
    detail?: string;
    suggestion?: string;
    traceId?: string;
    requestId?: string;
    action?: string;
}

export interface QueueResumeInfo {
    recoverable: boolean;
    canReuseSourceSubtitles: boolean;
    canReuseTranslatedSubtitles: boolean;
    canResumeDubbing: boolean;
    canResumeMerge: boolean;
    preservedAudioSegments: number;
    blockedReason?: string;
    lastMode?: 'success' | 'failed' | 'interrupted';
}
