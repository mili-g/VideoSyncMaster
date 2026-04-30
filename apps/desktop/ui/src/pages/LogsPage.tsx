import { useCallback, useEffect, useMemo, useState } from 'react';
import PageFrame from '../layout/PageFrame';

interface LogsPageProps {
    active?: boolean;
    onStatusChange?: (status: string) => void;
}

interface BackendLogState {
    path: string;
    exists: boolean;
    size: number;
    updatedAt: string | null;
    content: string;
}

const EMPTY_LOG_STATE: BackendLogState = {
    path: '',
    exists: false,
    size: 0,
    updatedAt: null,
    content: ''
};

function formatBytes(size: number) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTimestamp(value: string | null) {
    if (!value) return '未生成';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('zh-CN', { hour12: false });
}

export default function LogsPage({ active = false, onStatusChange }: LogsPageProps) {
    const [logState, setLogState] = useState<BackendLogState>(EMPTY_LOG_STATE);
    const [loading, setLoading] = useState(false);
    const [clearing, setClearing] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');

    const refreshLogs = useCallback(async (silent = false) => {
        if (!silent) {
            setLoading(true);
        }

        try {
            const result = await window.api.readBackendLog();
            if (!result.success) {
                throw new Error(result.error || '读取日志失败');
            }

            setLogState({
                path: result.path || '',
                exists: Boolean(result.exists),
                size: Number(result.size || 0),
                updatedAt: result.updatedAt || null,
                content: result.content || ''
            });
            setErrorMessage('');

            if (!silent) {
                onStatusChange?.(result.exists ? '运行日志已刷新。' : '当前尚未生成运行日志。');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setErrorMessage(message);
            if (!silent) {
                onStatusChange?.(`刷新日志失败: ${message}`);
            }
        } finally {
            if (!silent) {
                setLoading(false);
            }
        }
    }, [onStatusChange]);

    useEffect(() => {
        if (!active) return;

        void refreshLogs();
        const timer = window.setInterval(() => {
            void refreshLogs(true);
        }, 3000);

        return () => window.clearInterval(timer);
    }, [active, refreshLogs]);

    const lineCount = useMemo(() => {
        if (!logState.content) return 0;
        return logState.content.split(/\r?\n/).filter((line) => line.length > 0).length;
    }, [logState.content]);

    const handleClear = useCallback(async () => {
        setClearing(true);
        try {
            const result = await window.api.clearBackendLog();
            if (!result.success) {
                throw new Error(result.error || '清空日志失败');
            }
            await refreshLogs(true);
            onStatusChange?.('运行日志已清空。');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setErrorMessage(message);
            onStatusChange?.(`清空日志失败: ${message}`);
        } finally {
            setClearing(false);
        }
    }, [onStatusChange, refreshLogs]);

    const handleExport = useCallback(async () => {
        setExporting(true);
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const result = await window.api.showSaveDialog({
                title: '导出运行日志',
                defaultPath: `backend_debug_${timestamp}.log`
            });
            if (result.canceled || !result.filePath) {
                return;
            }

            await window.api.saveFile(result.filePath, logState.content || '');
            onStatusChange?.(`运行日志已导出到: ${result.filePath}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setErrorMessage(message);
            onStatusChange?.(`导出日志失败: ${message}`);
        } finally {
            setExporting(false);
        }
    }, [logState.content, onStatusChange]);

    const handleOpenFolder = useCallback(() => {
        if (!logState.path) {
            onStatusChange?.('日志路径不可用。');
            return;
        }
        void window.api.openFolder(logState.path);
    }, [logState.path, onStatusChange]);

    return (
        <div className="view-page-shell">
            <PageFrame
                eyebrow="Logs"
                title="运行日志"
                description="在应用内查看后端日志，支持刷新、清空和导出。"
                headerMode="hidden"
            >
                <div className="config-page">
                    <div className="config-page__hero">
                        <div>
                            <span className="config-page__eyebrow">Observability</span>
                            <h1>运行日志</h1>
                            <p>用于排查任务执行异常和下载、模型、环境相关问题。</p>
                        </div>
                        <div className="config-page__hero-meta">
                            <div className="status-kpi">
                                <span className="status-kpi__label">日志状态</span>
                                <strong>{logState.exists ? '可读取' : '未生成'}</strong>
                            </div>
                            <div className="status-kpi">
                                <span className="status-kpi__label">行数</span>
                                <strong>{lineCount}</strong>
                            </div>
                            <div className="status-kpi">
                                <span className="status-kpi__label">大小</span>
                                <strong>{formatBytes(logState.size)}</strong>
                            </div>
                        </div>
                    </div>

                    <div className="model-toolbar">
                        <div className="model-root-card">
                            <span className="model-root-card__label">日志文件</span>
                            <strong title={logState.path || '暂无路径'}>{logState.path || 'backend_debug.log'}</strong>
                            <small>最后更新时间: {formatTimestamp(logState.updatedAt)}</small>
                        </div>
                        <div className="output-dir-toolbar__actions">
                            <button type="button" className="secondary-button" onClick={() => void refreshLogs()} disabled={loading}>
                                {loading ? '刷新中' : '刷新'}
                            </button>
                            <button type="button" className="secondary-button" onClick={handleOpenFolder} disabled={!logState.path}>
                                打开目录
                            </button>
                            <button type="button" className="secondary-button" onClick={() => void handleExport()} disabled={exporting}>
                                {exporting ? '导出中' : '导出日志'}
                            </button>
                            <button type="button" className="secondary-button secondary-button--danger" onClick={() => void handleClear()} disabled={clearing}>
                                {clearing ? '清理中' : '清空日志'}
                            </button>
                        </div>
                    </div>

                    {errorMessage && (
                        <section className="config-section">
                            <div className="config-section__head">
                                <div>
                                    <h3>日志读取失败</h3>
                                    <p>{errorMessage}</p>
                                </div>
                            </div>
                        </section>
                    )}

                    <section className="config-section">
                        <div className="config-section__head">
                            <div>
                                <h3>日志内容</h3>
                                <p>页面激活时每 3 秒自动刷新一次。</p>
                            </div>
                        </div>
                        <div className="log-viewer">
                            {logState.content ? (
                                <pre className="log-viewer__content">{logState.content}</pre>
                            ) : (
                                <div className="log-viewer__empty">当前没有可显示的日志内容。</div>
                            )}
                        </div>
                    </section>
                </div>
            </PageFrame>
        </div>
    );
}
