export type ExecutionConsoleLevel = 'info' | 'warn' | 'error' | 'progress' | 'stage';

export interface ExecutionConsoleEntry {
    id: string;
    timestamp: number;
    level: ExecutionConsoleLevel;
    origin: 'progress' | 'stage' | 'issue' | 'deps' | 'raw';
    title: string;
    detail?: string;
    stage?: string;
    code?: string;
    category?: string;
    retryable?: boolean;
    traceId?: string;
    requestId?: string;
    action?: string;
}

export interface RawBackendLogLine {
    id: string;
    timestamp: number;
    source: 'stdout' | 'stderr';
    lane: 'default' | 'prep';
    level: 'info' | 'warn' | 'error';
    logType?: 'business' | 'error' | 'security' | 'debug';
    domain?: string;
    traceId?: string;
    requestId?: string;
    action?: string;
    event?: string;
    stage?: string;
    code?: string;
    retryable?: boolean;
    detail?: string;
    text: string;
}
