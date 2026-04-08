import React, { useRef } from 'react';
import type { BatchQueueItem } from '../hooks/useBatchQueue';
import type { BatchInputAsset } from '../utils/batchAssets';

const suspiciousMojibakePattern = /[\uFFFD\u00C3\u00E2\u00D0\u00CF]/;

interface BatchQueueSummary {
    total: number;
    pending: number;
    processing: number;
    success: number;
    error: number;
    canceled: number;
    totalSourceDurationSec: number;
    totalElapsedMs: number;
    nowEpochMs: number;
}

interface BatchQueuePanelProps {
    items: BatchQueueItem[];
    summary: BatchQueueSummary;
    isRunning: boolean;
    canStart: boolean;
    onAddAssets: (assets: BatchInputAsset[]) => void | Promise<void>;
    onRemoveItem: (id: string) => void;
    onClearCompleted: () => void;
    onClearAll: () => void;
    onRetryFailed: () => void;
    onOpenOutput: (item: BatchQueueItem) => void;
    onStart: () => void;
    onStop: () => void;
}

const statusColor: Record<BatchQueueItem['status'], string> = {
    pending: '#94a3b8',
    processing: '#60a5fa',
    success: '#34d399',
    error: '#f87171',
    canceled: '#fbbf24'
};

async function decodeSubtitleFile(file: File) {
    const buffer = await file.arrayBuffer();

    try {
        const utf8Text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        if (!suspiciousMojibakePattern.test(utf8Text)) {
            return utf8Text;
        }
    } catch (error) {
        console.warn('UTF-8 subtitle decode failed, falling back to gb18030:', error);
    }

    const gb18030Text = new TextDecoder('gb18030').decode(buffer);
    return gb18030Text || new TextDecoder('utf-8').decode(buffer);
}

export default function BatchQueuePanel({
    items,
    summary,
    isRunning,
    canStart,
    onAddAssets,
    onRemoveItem,
    onClearCompleted,
    onClearAll,
    onRetryFailed,
    onOpenOutput,
    onStart,
    onStop
}: BatchQueuePanelProps) {
    const inputRef = useRef<HTMLInputElement>(null);

    const consumeFiles = async (fileList: FileList | null) => {
        if (!fileList) return;
        const assets = await Promise.all(
            Array.from(fileList).map(async (file) => {
                const path = (file as File & { path?: string }).path || '';
                const name = file.name;
                const textContent = name.toLowerCase().endsWith('.srt') ? await decodeSubtitleFile(file) : undefined;
                return { path, name, textContent };
            })
        );
        await onAddAssets(assets.filter(asset => asset.path));
    };

    return (
        <div style={{ flex: 1, margin: '10px', overflow: 'auto' }}>
            <div className="glass-panel" style={{ padding: '24px', borderRadius: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', marginBottom: '20px', flexWrap: 'wrap' }}>
                    <div>
                        <h2 style={{ margin: 0, color: '#fff' }}>批量处理队列</h2>
                        <p style={{ margin: '8px 0 0', color: 'rgba(255,255,255,0.72)' }}>
                            支持视频、原字幕、翻译字幕自动匹配。资源越完整，批处理会自动跳过越多步骤。
                        </p>
                    </div>

                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                        <input
                            ref={inputRef}
                            type="file"
                            accept="video/*,audio/*,.srt"
                            multiple
                            style={{ display: 'none' }}
                            onChange={async (event) => { await consumeFiles(event.target.files); }}
                        />
                        <button onClick={() => inputRef.current?.click()} style={buttonStyle('#4f46e5')}>
                            添加资源
                        </button>
                        <button onClick={onRetryFailed} style={buttonStyle('rgba(59,130,246,0.28)')}>
                            重试失败项
                        </button>
                        <button onClick={onClearCompleted} style={buttonStyle('rgba(255,255,255,0.12)')}>
                            清理已完成
                        </button>
                        <button onClick={onClearAll} disabled={isRunning || items.length === 0} style={buttonStyle('rgba(255,255,255,0.08)', isRunning || items.length === 0)}>
                            清空队列
                        </button>
                        {!isRunning ? (
                            <button onClick={onStart} disabled={!canStart} style={buttonStyle('#059669', !canStart)}>
                                启动队列
                            </button>
                        ) : (
                            <button onClick={onStop} style={buttonStyle('#dc2626')}>
                                停止队列
                            </button>
                        )}
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, minmax(100px, 1fr))', gap: '12px', marginBottom: '20px' }}>
                    <SummaryCard label="总数" value={summary.total} color="#e2e8f0" />
                    <SummaryCard label="待处理" value={summary.pending} color="#94a3b8" />
                    <SummaryCard label="处理中" value={summary.processing} color="#60a5fa" />
                    <SummaryCard label="成功" value={summary.success} color="#34d399" />
                    <SummaryCard label="失败" value={summary.error} color="#f87171" />
                    <SummaryCard label="已取消" value={summary.canceled} color="#fbbf24" />
                    <SummaryCard label="总视频时长" value={formatDuration(summary.totalSourceDurationSec)} color="#c4b5fd" />
                    <SummaryCard label="总运行时长" value={formatElapsed(summary.totalElapsedMs)} color="#f9a8d4" />
                </div>

                <div
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={async (event) => {
                        event.preventDefault();
                        await consumeFiles(event.dataTransfer.files);
                    }}
                    style={{
                        border: '1px dashed rgba(255,255,255,0.2)',
                        borderRadius: '16px',
                        padding: '16px',
                        marginBottom: '20px',
                        color: 'rgba(255,255,255,0.7)',
                        background: 'rgba(255,255,255,0.03)'
                    }}
                >
                    可以一次拖入视频和字幕文件。系统会按文件名自动匹配到“视频 / 原字幕 / 翻译字幕”三列。
                </div>

                <div style={{ display: 'grid', gap: '12px' }}>
                    {items.length === 0 && (
                        <div style={{ padding: '24px', textAlign: 'center', color: 'rgba(255,255,255,0.6)' }}>
                            队列为空。先加入视频文件，字幕文件可一起拖入自动匹配。
                        </div>
                    )}

                    {items.map(item => (
                        <div
                            key={item.id}
                            style={{
                                display: 'grid',
                                gridTemplateColumns: '1.2fr 1fr 1fr 0.7fr 0.9fr 1fr auto',
                                gap: '12px',
                                alignItems: 'center',
                                padding: '14px 16px',
                                borderRadius: '14px',
                                background: 'rgba(15, 23, 42, 0.45)',
                                border: '1px solid rgba(255,255,255,0.08)'
                            }}
                        >
                            <Cell title="视频文件" primary={item.fileName} secondary={item.sourcePath} />
                            <Cell title="原字幕" primary={displayName(item.originalSubtitlePath)} secondary={item.originalSubtitlePath} emptyText="自动 ASR" />
                            <Cell title="翻译字幕" primary={displayName(item.translatedSubtitlePath)} secondary={item.translatedSubtitlePath} emptyText="自动翻译" />
                            <div>
                                <span style={{
                                    display: 'inline-flex',
                                    padding: '4px 10px',
                                    borderRadius: '999px',
                                    color: '#fff',
                                    background: statusColor[item.status],
                                    fontSize: '0.8em',
                                    fontWeight: 600
                                }}>
                                    {statusLabel(item.status)}
                                </span>
                            </div>
                            <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: '0.9em' }}>
                                <div>视频: {formatDuration(item.sourceDurationSec)}</div>
                                <div style={{ marginTop: '6px' }}>耗时: {formatItemElapsed(item, summary.nowEpochMs)}</div>
                            </div>
                            <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: '0.9em' }}>
                                <div>{item.stage}</div>
                                {item.outputPath && <div style={{ marginTop: '6px', color: '#93c5fd' }}>输出已生成</div>}
                                {item.error && <div style={{ marginTop: '6px', color: '#fca5a5' }}>{item.error}</div>}
                            </div>
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                {item.outputPath && (
                                    <button onClick={() => onOpenOutput(item)} style={buttonStyle('rgba(59,130,246,0.18)')}>
                                        打开输出
                                    </button>
                                )}
                                <button
                                    onClick={() => onRemoveItem(item.id)}
                                    disabled={item.status === 'processing'}
                                    style={buttonStyle('rgba(255,255,255,0.08)', item.status === 'processing')}
                                >
                                    移除
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function SummaryCard({ label, value, color }: { label: string; value: number | string; color: string }) {
    return (
        <div style={{
            padding: '14px',
            borderRadius: '14px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)'
        }}>
            <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: '0.82em' }}>{label}</div>
            <div style={{ color, fontSize: '1.5em', fontWeight: 700, marginTop: '4px' }}>{value}</div>
        </div>
    );
}

function Cell({ title, primary, secondary, emptyText }: { title: string; primary?: string; secondary?: string; emptyText?: string }) {
    return (
        <div style={{ minWidth: 0 }}>
            <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.78em', marginBottom: '4px' }}>{title}</div>
            <div style={{ color: '#fff', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {primary || emptyText || '未设置'}
            </div>
            {secondary && (
                <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.82em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {secondary}
                </div>
            )}
        </div>
    );
}

function displayName(filePath?: string) {
    if (!filePath) return '';
    return filePath.split(/[\\/]/).pop() || filePath;
}

function formatDuration(seconds?: number) {
    if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '--';
    const totalSeconds = Math.round(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatElapsed(milliseconds?: number) {
    if (!milliseconds || !Number.isFinite(milliseconds) || milliseconds <= 0) return '0s';

    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
}

function formatItemElapsed(item: BatchQueueItem, nowEpochMs: number) {
    if (typeof item.elapsedMs === 'number' && item.elapsedMs >= 0) {
        return formatElapsed(item.elapsedMs);
    }
    if (item.startedAt) {
        return formatElapsed(Math.max(0, nowEpochMs - item.startedAt));
    }
    return '--';
}

function buttonStyle(background: string, disabled = false): React.CSSProperties {
    return {
        padding: '10px 16px',
        borderRadius: '10px',
        border: '1px solid rgba(255,255,255,0.12)',
        background,
        color: '#fff',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1
    };
}

function statusLabel(status: BatchQueueItem['status']) {
    switch (status) {
        case 'pending':
            return '待处理';
        case 'processing':
            return '处理中';
        case 'success':
            return '成功';
        case 'error':
            return '失败';
        case 'canceled':
            return '已取消';
        default:
            return status;
    }
}
