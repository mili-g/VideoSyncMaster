export type ExecutionConsoleLevel = 'info' | 'warn' | 'error' | 'progress' | 'stage';

export interface ExecutionConsoleEntry {
    id: string;
    timestamp: number;
    level: ExecutionConsoleLevel;
    origin: 'progress' | 'stage' | 'issue' | 'deps' | 'raw';
    title: string;
    detail?: string;
    stage?: string;
}

export interface RawBackendLogLine {
    id: string;
    timestamp: number;
    source: 'stdout' | 'stderr';
    lane: 'default' | 'prep';
    level: 'info' | 'warn' | 'error';
    text: string;
}
