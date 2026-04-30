import type { ExecutionConsoleEntry, RawBackendLogLine } from '../types/executionConsole';
import { BACKEND_COMMAND_CATALOG_BY_NAME } from '../types/backendCommandCatalog';
import { getCodeReference, getStageReference } from '../utils/diagnosticCatalog';

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

function buildActionReference(action?: string) {
    if (!action) return null;
    const command = BACKEND_COMMAND_CATALOG_BY_NAME[action];
    if (!command) return null;
    return {
        description: command.description,
        category: command.category,
        requiredArgs: command.args.filter((arg) => arg.required).map((arg) => arg.name)
    };
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
    const retryableIssueCount = entries.filter(entry => (entry.level === 'error' || entry.level === 'warn') && entry.retryable).length;
    const categorySummary = Array.from(
        entries.reduce((map, entry) => {
            if (!entry.category) return map;
            map.set(entry.category, (map.get(entry.category) || 0) + 1);
            return map;
        }, new Map<string, number>())
    ).slice(0, 4);

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
                        {retryableIssueCount > 0 && <span>{retryableIssueCount} 条问题可重试</span>}
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
                        查看完整日志
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
                        {categorySummary.length > 0 && <span>{categorySummary.map(([key, count]) => `${key}:${count}`).join(' / ')}</span>}
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
                            <div className="execution-console__empty">任务开始后将在此显示关键原始输出。</div>
                        )}
                        {rawPreview.map(line => {
                            const actionReference = buildActionReference(line.action);
                            const stageReference = getStageReference(line.stage);
                            const codeReference = getCodeReference(line.code);
                            return (
                                <div key={line.id} className={`execution-console__raw execution-console__raw--${line.level}`}>
                                    <span className="execution-console__raw-meta">
                                        [{formatClock(line.timestamp)}] [{line.source}] [{line.lane}]
                                        {line.logType ? ` [${line.logType}]` : ''}
                                        {line.domain ? ` [${line.domain}]` : ''}
                                    </span>
                                    <span className="execution-console__raw-text">{line.text}</span>
                                    {actionReference && (
                                        <span className="execution-console__raw-meta">
                                            动作 {line.action} · {actionReference.description}
                                            {actionReference.requiredArgs.length > 0 ? ` · 必填参数: ${actionReference.requiredArgs.join(', ')}` : ''}
                                        </span>
                                    )}
                                    {stageReference && (
                                        <span className="execution-console__raw-meta">
                                            阶段 {line.stage} · {stageReference.description}
                                        </span>
                                    )}
                                    {codeReference && (
                                        <span className="execution-console__raw-meta">
                                            错误码 {line.code} · {codeReference.description}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>

                <div className="execution-console__panel execution-console__panel--events">
                    <div className="execution-console__panel-head">
                        <h3>关键事件</h3>
                        <span>{recentEntries.length} 条</span>
                    </div>
                    <div className="execution-console__event-list">
                        {recentEntries.length === 0 && (
                            <div className="execution-console__empty">任务开始后将在此显示阶段进度与关键事件。</div>
                        )}
                        {recentEntries.map(entry => {
                            const palette = levelPalette[entry.level];
                            const actionReference = buildActionReference(entry.action);
                            const stageReference = getStageReference(entry.stage);
                            const codeReference = getCodeReference(entry.code);
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
                                    {actionReference && (
                                        <div className="execution-console__detail">
                                            {actionReference.description}
                                            {actionReference.requiredArgs.length > 0 ? ` · 必填参数: ${actionReference.requiredArgs.join(', ')}` : ''}
                                        </div>
                                    )}
                                    {stageReference && (
                                        <div className="execution-console__detail">
                                            {stageReference.label} · {stageReference.description}
                                        </div>
                                    )}
                                    {codeReference && (
                                        <div className="execution-console__detail">
                                            {codeReference.label} · {codeReference.description}
                                        </div>
                                    )}
                                    {(entry.category || entry.traceId || entry.action || typeof entry.retryable === 'boolean') && (
                                        <div className="execution-console__detail">
                                            {[
                                                entry.category ? `分类 ${entry.category}` : '',
                                                actionReference?.category ? `命令分类 ${actionReference.category}` : '',
                                                entry.code ? `错误码 ${entry.code}` : '',
                                                entry.stage ? `阶段 ${entry.stage}` : '',
                                                typeof entry.retryable === 'boolean' ? `可重试 ${entry.retryable ? '是' : '否'}` : '',
                                                entry.action ? `动作 ${entry.action}` : '',
                                                entry.traceId ? `Trace ${entry.traceId}` : ''
                                            ].filter(Boolean).join(' · ')}
                                        </div>
                                    )}
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
                            <div className="execution-console__empty">当前未发现新的告警或错误。</div>
                        )}
                        {issues.map(entry => {
                            const actionReference = buildActionReference(entry.action);
                            const stageReference = getStageReference(entry.stage);
                            const codeReference = getCodeReference(entry.code);
                            return (
                                <div key={entry.id} className={`execution-console__issue execution-console__issue--${entry.level}`}>
                                    <div className="execution-console__issue-head">
                                        <strong>{entry.title}</strong>
                                        <span>{formatClock(entry.timestamp)}</span>
                                    </div>
                                    {entry.detail && <div className="execution-console__issue-detail">{entry.detail}</div>}
                                    {actionReference && (
                                        <div className="execution-console__issue-detail">
                                            {entry.action} · {actionReference.description}
                                        </div>
                                    )}
                                    {stageReference && (
                                        <div className="execution-console__issue-detail">
                                            {stageReference.label} · {stageReference.description}
                                        </div>
                                    )}
                                    {codeReference && (
                                        <div className="execution-console__issue-detail">
                                            {entry.code} · {codeReference.description}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </section>
    );
}
