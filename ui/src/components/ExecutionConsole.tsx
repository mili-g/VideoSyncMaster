import type { ExecutionConsoleEntry, RawBackendLogLine } from '../types/executionConsole';

interface ExecutionConsoleProps {
    status: string;
    progress: number;
    isIndeterminate: boolean;
    isBusy: boolean;
    installingDeps: boolean;
    depsPackageName: string;
    entries: ExecutionConsoleEntry[];
    rawLogLines: RawBackendLogLine[];
    onStop: () => void;
    onClearStatus: () => void;
    onClearConsole: () => void;
    onOpenLog: () => void;
}

const levelPalette = {
    info: { dot: '#60a5fa', text: '#dbeafe', bg: 'rgba(37,99,235,0.14)' },
    warn: { dot: '#f59e0b', text: '#fef3c7', bg: 'rgba(245,158,11,0.14)' },
    error: { dot: '#f87171', text: '#fee2e2', bg: 'rgba(220,38,38,0.16)' },
    progress: { dot: '#22c55e', text: '#dcfce7', bg: 'rgba(22,163,74,0.14)' },
    stage: { dot: '#a78bfa', text: '#ede9fe', bg: 'rgba(109,40,217,0.16)' }
} as const;

function formatClock(timestamp: number) {
    return new Date(timestamp).toLocaleTimeString('zh-CN', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function formatRelative(timestamp: number) {
    const diff = Math.max(0, Date.now() - timestamp);
    if (diff < 5_000) return '刚刚';
    if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前`;
    return `${Math.round(diff / 60_000)} 分钟前`;
}

function summaryLabel(count: number, emptyLabel: string, filledLabel: string) {
    return count > 0 ? `${count} ${filledLabel}` : emptyLabel;
}

export default function ExecutionConsole({
    status,
    progress,
    isIndeterminate,
    isBusy,
    installingDeps,
    depsPackageName,
    entries,
    rawLogLines,
    onStop,
    onClearStatus,
    onClearConsole,
    onOpenLog
}: ExecutionConsoleProps) {
    const issues = entries.filter(entry => entry.level === 'error' || entry.level === 'warn').slice(0, 4);
    const recentEntries = entries.slice(0, 8);
    const rawPreview = rawLogLines.slice(0, 18);
    const errorCount = entries.filter(entry => entry.level === 'error').length;
    const warnCount = entries.filter(entry => entry.level === 'warn').length;
    const latestEntry = entries[0];

    return (
        <section className="execution-console">
            <div className="execution-console__header">
                <div className="execution-console__status">
                    <div className="execution-console__eyebrow">运行状态</div>
                    <div className="execution-console__headline">
                        {status || '等待任务'}
                    </div>
                    <div className="execution-console__meta">
                        <span>{isBusy ? '任务进行中' : '空闲'}</span>
                        {installingDeps && <span>依赖切换: {depsPackageName || '处理中'}</span>}
                        {latestEntry && <span>最近更新 {formatRelative(latestEntry.timestamp)}</span>}
                    </div>
                </div>

                <div className="execution-console__actions">
                    {isBusy ? (
                        <button onClick={onStop} className="execution-console__button execution-console__button--danger">
                            停止任务
                        </button>
                    ) : (
                        <button onClick={onClearStatus} className="execution-console__button">
                            清空状态
                        </button>
                    )}
                    <button onClick={onClearConsole} className="execution-console__button">
                        清空控制台
                    </button>
                    <button onClick={onOpenLog} className="execution-console__button execution-console__button--primary">
                        打开完整日志
                    </button>
                </div>
            </div>

            {isBusy && (
                <div className="execution-console__progress">
                    <div className="execution-console__progress-track">
                        <div
                            className={`execution-console__progress-fill${isIndeterminate ? ' execution-console__progress-fill--indeterminate' : ''}`}
                            style={{
                                width: isIndeterminate ? '28%' : `${Math.max(0, Math.min(100, progress))}%`
                            }}
                        />
                    </div>
                    <div className="execution-console__progress-meta">
                        <span>{isIndeterminate ? '处理中' : `${Math.round(progress)}%`}</span>
                        <span>{summaryLabel(errorCount, '无错误', '个错误')}</span>
                        <span>{summaryLabel(warnCount, '无警告', '个警告')}</span>
                    </div>
                </div>
            )}

            <div className="execution-console__workspace">
                <div className="execution-console__panel execution-console__panel--raw">
                    <div className="execution-console__panel-head">
                        <h3>过滤后的原始输出</h3>
                        <span>{rawLogLines.length} 行</span>
                    </div>
                    <div className="execution-console__raw-list">
                        {rawPreview.length === 0 && (
                            <div className="execution-console__empty">只保留高价值原始输出，例如 warning、error、依赖切换、阶段切换和关键步骤。</div>
                        )}
                        {rawPreview.map(line => (
                            <div key={line.id} className={`execution-console__raw execution-console__raw--${line.level}`}>
                                <span className="execution-console__raw-meta">
                                    [{formatClock(line.timestamp)}] [{line.source}] [{line.lane}]
                                </span>
                                <span className="execution-console__raw-text">{line.text}</span>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="execution-console__panel execution-console__panel--events">
                    <div className="execution-console__panel-head">
                        <h3>关键事件</h3>
                        <span>{recentEntries.length} 条</span>
                    </div>
                    <div className="execution-console__event-list">
                        {recentEntries.length === 0 && (
                            <div className="execution-console__empty">任务开始后会在这里显示阶段、异常和关键进度。</div>
                        )}
                        {recentEntries.map(entry => {
                            const palette = levelPalette[entry.level];
                            return (
                                <div key={entry.id} className="execution-console__event">
                                    <div className="execution-console__event-top">
                                        <div className="execution-console__badge" style={{ background: palette.bg, color: palette.text }}>
                                            <span className="execution-console__dot" style={{ background: palette.dot }} />
                                            {entry.level.toUpperCase()}
                                        </div>
                                        <div className="execution-console__time">{formatClock(entry.timestamp)}</div>
                                    </div>
                                    <div className="execution-console__title">{entry.title}</div>
                                    {entry.detail && <div className="execution-console__detail">{entry.detail}</div>}
                                </div>
                            );
                        })}
                    </div>
                </div>

                <div className="execution-console__panel execution-console__panel--issues">
                    <div className="execution-console__panel-head">
                        <h3>诊断焦点</h3>
                        <span>{issues.length > 0 ? `${issues.length} 条待关注` : '正常'}</span>
                    </div>
                    <div className="execution-console__issues">
                        {issues.length === 0 && (
                            <div className="execution-console__empty">当前没有新的告警或错误，优先关注左侧关键事件和原始输出。</div>
                        )}
                        {issues.map(entry => (
                            <div key={entry.id} className={`execution-console__issue execution-console__issue--${entry.level}`}>
                                <div className="execution-console__issue-head">
                                    <strong>{entry.title}</strong>
                                    <span>{formatClock(entry.timestamp)}</span>
                                </div>
                                {entry.detail && <div className="execution-console__issue-detail">{entry.detail}</div>}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}
