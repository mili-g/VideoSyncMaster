/// <reference types="vite/client" />

declare module 'rollup-plugin-javascript-obfuscator';

interface DesktopApi {
    getFileUrl(filePath: string): Promise<string>;
    saveFile(filePath: string, content: string): Promise<boolean>;
    ensureDir(dirPath: string): Promise<boolean>;
    deletePath(targetPath: string): Promise<boolean>;
    checkFileExists(filePath: string): Promise<boolean>;
    getPaths(): Promise<{ projectRoot: string; outputDir: string; cacheDir: string }>;
    runBackend(args: string[], options?: { lane?: 'default' | 'prep' }): Promise<any>;
    analyzeVideoMetadata(filePath: string): Promise<any>;
    cacheVideo(filePath: string): Promise<string>;
    openFolder(filePath: string): Promise<boolean>;
    openExternal(filePath: string): Promise<boolean>;
    openBackendLog(): Promise<{ success: boolean; error?: string }>;
    killBackend(): Promise<boolean>;
    fixPythonEnv(): Promise<{ success: boolean; output?: string; error?: string }>;
    checkPythonEnv(): Promise<any>;
    checkModelStatus(): Promise<any>;
    downloadModel(payload: { key: string; model: string; localDir: string }): Promise<any>;
    downloadFile(payload: { key: string; url: string; targetDir: string; name: string; outputFileName?: string }): Promise<any>;
    cancelDownload(payload: { key: string }): Promise<any>;
    cancelFileDownload(payload: { key: string }): Promise<any>;
    openFileDialog(options: unknown): Promise<any>;
    showSaveDialog(options: unknown): Promise<any>;
    onBackendProgress(listener: (value: unknown) => void): () => void;
    onBackendStage(listener: (data: unknown) => void): () => void;
    onBackendIssue(listener: (data: unknown) => void): () => void;
    onBackendPartialResult(listener: (data: unknown) => void): () => void;
    onBackendDepsInstalling(listener: (pkgName: string) => void): () => void;
    onBackendDepsDone(listener: () => void): () => void;
    onMainProcessMessage(listener: (message: string) => void): () => void;
}

interface Window {
    api: DesktopApi;
    ipcRenderer: {
        on: (...args: any[]) => unknown;
        off: (...args: any[]) => unknown;
        send: (...args: any[]) => unknown;
        invoke: (...args: any[]) => Promise<any>;
    };
}

declare namespace JSX {
    interface IntrinsicElements {
        'theme-button': any;
    }
}
