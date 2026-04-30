/// <reference types="vite/client" />

declare module 'rollup-plugin-javascript-obfuscator';

type BackendLane = 'default' | 'prep';

interface DesktopApi {
    getFileUrl(filePath: string): Promise<string>;
    saveFile(filePath: string, content: string): Promise<boolean>;
    readFile(filePath: string): Promise<string>;
    ensureDir(dirPath: string): Promise<boolean>;
    deletePath(targetPath: string): Promise<boolean>;
    cleanupSessionCache(payload: { sessionCacheDir: string; mode: 'success' | 'failed' | 'interrupted' }): Promise<{ success: boolean; removed: boolean; preservedResumeFiles: number }>;
    checkFileExists(filePath: string): Promise<boolean>;
    getPaths(): Promise<{ projectRoot: string; outputDir: string; cacheDir: string; logsDir: string; backendLogPath: string }>;
    runBackend<T = import('./types/backend').BackendResponseBase>(args: string[], options?: { lane?: BackendLane }): Promise<T>;
    analyzeVideoMetadata(filePath: string): Promise<import('./types/backend').AnalyzeVideoMetadataResponse>;
    cacheVideo(filePath: string): Promise<string>;
    openFolder(filePath: string): Promise<boolean>;
    openExternal(filePath: string): Promise<boolean>;
    openBackendLog(): Promise<{ success: boolean; error?: string }>;
    readBackendLog(): Promise<{ success: boolean; path?: string; exists?: boolean; size?: number; updatedAt?: string | null; content?: string; error?: string }>;
    clearBackendLog(): Promise<{ success: boolean; path?: string; error?: string }>;
    installFunasrRuntime(payload: { key: string }): Promise<import('./types/backend').BackendResponseBase>;
    killBackend(): Promise<boolean>;
    fixPythonEnv(): Promise<{ success: boolean; output?: string; error?: string }>;
    checkPythonEnv(): Promise<import('./types/backend').PythonEnvCheckResponse>;
    checkModelStatus(): Promise<import('./types/backend').ModelStatusResponse>;
    runAsrDiagnostics(): Promise<import('./types/backend').AsrDiagnosticsResponse>;
    downloadModel(payload: { key: string; model: string; localDir: string }): Promise<import('./types/backend').BackendResponseBase>;
    downloadFile(payload: { key: string; url: string; targetDir: string; name: string; outputFileName?: string; baseDir?: 'models' | 'project' }): Promise<import('./types/backend').BackendResponseBase>;
    installTransformers5AsrRuntime(payload: { key: string }): Promise<import('./types/backend').BackendResponseBase>;
    cancelDownload(payload: { key: string }): Promise<import('./types/backend').BackendResponseBase>;
    cancelFileDownload(payload: { key: string }): Promise<import('./types/backend').BackendResponseBase>;
    openFileDialog(options: unknown): Promise<import('./types/backend').FileDialogResult>;
    showSaveDialog(options: unknown): Promise<import('./types/backend').FileDialogResult>;
    minimizeWindow(): Promise<boolean>;
    toggleMaximizeWindow(): Promise<boolean>;
    closeWindow(): Promise<boolean>;
    isWindowMaximized(): Promise<boolean>;
    onBackendProgress(listener: (value: unknown) => void): () => void;
    onBackendStage(listener: (data: unknown) => void): () => void;
    onBackendIssue(listener: (data: unknown) => void): () => void;
    onBackendPartialResult(listener: (data: unknown) => void): () => void;
    onBackendDepsInstalling(listener: (pkgName: string) => void): () => void;
    onBackendDepsDone(listener: () => void): () => void;
    onBackendLogLine(listener: (line: import('./types/executionConsole').RawBackendLogLine) => void): () => void;
    onModelDownloadProgress(listener: (data: import('./types/backend').ModelDownloadProgressEvent) => void): () => void;
    onMainProcessMessage(listener: (message: string) => void): () => void;
}

interface Window {
    api: DesktopApi;
    ipcRenderer: {
        on: (...args: unknown[]) => unknown;
        off: (...args: unknown[]) => unknown;
        send: (...args: unknown[]) => unknown;
        invoke: <T = unknown>(...args: unknown[]) => Promise<T>;
    };
}

declare namespace JSX {
    interface IntrinsicElements {
        'theme-button': Record<string, unknown>;
    }
}
