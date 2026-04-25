import ExecutionConsole from './ExecutionConsole';
import type { ExecutionConsoleEntry, RawBackendLogLine } from '../types/executionConsole';

interface ConsoleDrawerProps {
    open: boolean;
    hasAttention: boolean;
    status: string;
    progress: number;
    isIndeterminate: boolean;
    isBusy: boolean;
    installingDeps: boolean;
    depsPackageName: string;
    entries: ExecutionConsoleEntry[];
    rawLogLines: RawBackendLogLine[];
    onToggle: () => void;
    onStop: () => void;
    onClearStatus: () => void;
    onClearConsole: () => void;
    onOpenLog: () => void;
}

export default function ConsoleDrawer({
    open,
    hasAttention,
    status,
    progress,
    isIndeterminate,
    isBusy,
    installingDeps,
    depsPackageName,
    entries,
    rawLogLines,
    onToggle,
    onStop,
    onClearStatus,
    onClearConsole,
    onOpenLog
}: ConsoleDrawerProps) {
    const issueCount = entries.filter(entry => entry.level === 'error' || entry.level === 'warn').length;

    return (
        <div className={`console-drawer${open ? ' console-drawer--open' : ''}`}>
            <button
                onClick={onToggle}
                className={`console-drawer__toggle${hasAttention ? ' console-drawer__toggle--attention' : ''}`}
                title={open ? '收起控制台' : '展开控制台'}
            >
                <span className="console-drawer__toggle-icon">{open ? '▾' : '▴'}</span>
                <span className="console-drawer__toggle-label">控制台</span>
                {isBusy && <span className="console-drawer__toggle-badge console-drawer__toggle-badge--busy">运行中</span>}
                {!isBusy && issueCount > 0 && <span className="console-drawer__toggle-badge">{issueCount}</span>}
            </button>

            <div className="console-drawer__panel">
                <ExecutionConsole
                    status={status}
                    progress={progress}
                    isIndeterminate={isIndeterminate}
                    isBusy={isBusy}
                    installingDeps={installingDeps}
                    depsPackageName={depsPackageName}
                    entries={entries}
                    rawLogLines={rawLogLines}
                    onStop={onStop}
                    onClearStatus={onClearStatus}
                    onClearConsole={onClearConsole}
                    onOpenLog={onOpenLog}
                />
            </div>
        </div>
    );
}
