import React, { useMemo, useRef, useState } from 'react';
import { BATCH_QUEUE_STAGE, type BatchQueueItem } from '../hooks/useBatchQueue';
import { classifyBatchAsset, getSubtitleAssignmentHint, validateSubtitleLanguageFit, type BatchInputAsset } from '../utils/batchAssets';
import { summarizeStructuredError } from '../utils/backendErrors';
import { TARGET_LANGUAGE_OPTIONS } from '../utils/languageTags';
import { ASR_SOURCE_LANGUAGE_OPTIONS, getAsrSourceLanguageLabel, type AsrSourceLanguage } from '../utils/asrService';

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
    unmatchedSubtitleAssets: BatchInputAsset[];
    summary: BatchQueueSummary;
    isRunning: boolean;
    canStart: boolean;
    canGenerateSubtitles: boolean;
    canGenerateTranslations: boolean;
    onAddAssets: (assets: BatchInputAsset[]) => void | Promise<void>;
    onAssignUnmatchedSubtitle: (
        assetPath: string,
        itemId: string,
        kind: Extract<ReturnType<typeof classifyBatchAsset>, 'subtitle-original' | 'subtitle-translated'>
    ) => void;
    onRemoveUnmatchedSubtitle: (assetPath: string) => void;
    onRemoveItem: (id: string) => void;
    onClearCompleted: () => void;
    onClearAll: () => void;
    onGenerateSubtitles: () => void;
    onGenerateTranslations: () => void;
    onRetryFailed: () => void;
    onOpenOutput: (item: BatchQueueItem) => void;
    onStart: () => void;
    onStop: () => void;
    targetLang: string;
    onSetTargetLang: (lang: string) => void;
    asrOriLang: AsrSourceLanguage;
    onSetAsrOriLang: (lang: AsrSourceLanguage) => void;
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
    unmatchedSubtitleAssets,
    summary,
    isRunning,
    canStart,
    canGenerateSubtitles,
    canGenerateTranslations,
    onAddAssets,
    onAssignUnmatchedSubtitle,
    onRemoveUnmatchedSubtitle,
    onRemoveItem,
    onClearCompleted,
    onClearAll,
    onGenerateSubtitles,
    onGenerateTranslations,
    onRetryFailed,
    onOpenOutput,
    onStart,
    onStop,
    targetLang,
    onSetTargetLang,
    asrOriLang,
    onSetAsrOriLang
}: BatchQueuePanelProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const originalSubtitleInputRef = useRef<HTMLInputElement>(null);
    const translatedSubtitleInputRef = useRef<HTMLInputElement>(null);
    const [manualAssignments, setManualAssignments] = useState<Record<string, { itemId: string; kind: 'subtitle-original' | 'subtitle-translated' }>>({});
    const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
    const getSubtitleKind = (asset: BatchInputAsset): 'subtitle-original' | 'subtitle-translated' => (
        classifyBatchAsset(asset) === 'subtitle-translated' ? 'subtitle-translated' : 'subtitle-original'
    );

    const unmatchedSelections = useMemo(() => {
        const next: Record<string, { itemId: string; kind: 'subtitle-original' | 'subtitle-translated' }> = {};
        for (const asset of unmatchedSubtitleAssets) {
            const existing = manualAssignments[asset.path];
            const hint = getSubtitleAssignmentHint(asset, asrOriLang, targetLang);
            next[asset.path] = {
                itemId: existing?.itemId || asset.suggestedItemId || items[0]?.id || '',
                kind: existing?.kind || hint.suggestedKind || getSubtitleKind(asset)
            };
        }
        return next;
    }, [asrOriLang, items, manualAssignments, targetLang, unmatchedSubtitleAssets]);

    const consumeFiles = async (
        fileList: FileList | null,
        kindOverride?: BatchInputAsset['kindOverride']
    ) => {
        if (!fileList) return;
        const assets = await Promise.all(
            Array.from(fileList).map(async (file) => {
                const path = (file as File & { path?: string }).path || '';
                const name = file.name;
                const textContent = name.toLowerCase().endsWith('.srt') ? await decodeSubtitleFile(file) : undefined;
                return { path, name, textContent, kindOverride };
            })
        );
        await onAddAssets(assets.filter(asset => asset.path));
    };

    return (
        <div style={{ flex: 1, margin: '10px', minHeight: 0, overflow: 'hidden' }}>
            <div
                className="glass-panel"
                style={{
                    height: '100%',
                    minHeight: 0,
                    padding: '24px',
                    borderRadius: '20px',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden'
                }}
            >
                <div style={{ flex: '0 0 auto', display: 'grid', gap: '20px', marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                    <div>
                        <h2 style={{ margin: 0, color: '#fff' }}>批量处理队列</h2>
                        <p style={{ margin: '8px 0 0', color: 'rgba(255,255,255,0.72)' }}>
                            管理批量素材、字幕资产与执行进度。
                        </p>
                    </div>

                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                        <div
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '8px',
                                padding: '6px 10px',
                                borderRadius: '10px',
                                border: '1px solid rgba(255,255,255,0.08)',
                                background: 'rgba(255,255,255,0.04)',
                                minWidth: 0
                            }}
                        >
                            <span
                                style={{
                                    color: 'rgba(255,255,255,0.72)',
                                    fontSize: '0.82em',
                                    whiteSpace: 'nowrap'
                                }}
                            >
                                源语言
                            </span>
                            <select
                                value={asrOriLang}
                                onChange={(event) => onSetAsrOriLang(event.target.value as AsrSourceLanguage)}
                                style={{
                                    ...selectStyle,
                                    width: 'auto',
                                    minWidth: '112px',
                                    padding: '6px 28px 6px 10px',
                                    background: 'rgba(15,23,42,0.72)',
                                    fontSize: '0.86em'
                                }}
                            >
                                {ASR_SOURCE_LANGUAGE_OPTIONS.map((option) => (
                                    <option key={option} value={option}>{getAsrSourceLanguageLabel(option)}</option>
                                ))}
                            </select>
                        </div>
                        <div
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '8px',
                                padding: '6px 10px',
                                borderRadius: '10px',
                                border: '1px solid rgba(255,255,255,0.08)',
                                background: 'rgba(255,255,255,0.04)',
                                minWidth: 0
                            }}
                        >
                            <span
                                style={{
                                    color: 'rgba(255,255,255,0.72)',
                                    fontSize: '0.82em',
                                    whiteSpace: 'nowrap'
                                }}
                            >
                                翻译语言
                            </span>
                            <select
                                value={targetLang}
                                onChange={(event) => onSetTargetLang(event.target.value)}
                                style={{
                                    ...selectStyle,
                                    width: 'auto',
                                    minWidth: '132px',
                                    padding: '6px 28px 6px 10px',
                                    background: 'rgba(15,23,42,0.72)',
                                    fontSize: '0.86em'
                                }}
                            >
                                {TARGET_LANGUAGE_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                            </select>
                        </div>
                        <input
                            ref={inputRef}
                            type="file"
                            accept="video/*,audio/*,.srt"
                            multiple
                            style={{ display: 'none' }}
                            onChange={async (event) => {
                                await consumeFiles(event.target.files);
                                event.target.value = '';
                            }}
                        />
                        <input
                            ref={originalSubtitleInputRef}
                            type="file"
                            accept=".srt"
                            multiple
                            style={{ display: 'none' }}
                            onChange={async (event) => {
                                await consumeFiles(event.target.files, 'subtitle-original');
                                event.target.value = '';
                            }}
                        />
                        <input
                            ref={translatedSubtitleInputRef}
                            type="file"
                            accept=".srt"
                            multiple
                            style={{ display: 'none' }}
                            onChange={async (event) => {
                                await consumeFiles(event.target.files, 'subtitle-translated');
                                event.target.value = '';
                            }}
                        />
                        <button onClick={() => inputRef.current?.click()} style={buttonStyle('accent')}>
                            添加资源
                        </button>
                        <button onClick={() => originalSubtitleInputRef.current?.click()} style={buttonStyle('secondary')}>
                            添加原字幕
                        </button>
                        <button onClick={() => translatedSubtitleInputRef.current?.click()} style={buttonStyle('secondary')}>
                            添加翻译字幕
                        </button>
                        <button onClick={onGenerateSubtitles} disabled={!canGenerateSubtitles} style={buttonStyle('accentSoft', !canGenerateSubtitles)}>
                            批量识别字幕
                        </button>
                        <button onClick={onGenerateTranslations} disabled={!canGenerateTranslations} style={buttonStyle('accentSoft', !canGenerateTranslations)}>
                            批量翻译字幕
                        </button>
                        <button onClick={onRetryFailed} style={buttonStyle('secondary')}>
                            重试失败项
                        </button>
                        <button onClick={onClearCompleted} style={buttonStyle('secondary')}>
                            清理已完成
                        </button>
                        <button onClick={onClearAll} disabled={isRunning || items.length === 0} style={buttonStyle('secondary', isRunning || items.length === 0)}>
                            清空队列
                        </button>
                        {!isRunning ? (
                            <button onClick={onStart} disabled={!canStart} style={buttonStyle('success', !canStart)}>
                                启动队列
                            </button>
                        ) : (
                            <button onClick={onStop} style={buttonStyle('danger')}>
                                停止队列
                            </button>
                        )}
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, minmax(100px, 1fr))', gap: '12px' }}>
                    <SummaryCard label="总数" value={summary.total} color="#e2e8f0" />
                    <SummaryCard label="待处理" value={summary.pending} color="#94a3b8" />
                    <SummaryCard label="处理中" value={summary.processing} color="#60a5fa" />
                    <SummaryCard label="成功" value={summary.success} color="#34d399" />
                    <SummaryCard label="失败" value={summary.error} color="#f87171" />
                    <SummaryCard label="已取消" value={summary.canceled} color="#fbbf24" />
                    <SummaryCard label="总视频时长" value={formatDuration(summary.totalSourceDurationSec)} color="#c4b5fd" />
                    <SummaryCard label="总运行时长" value={formatElapsed(summary.totalElapsedMs)} color="#f9a8d4" />
                </div>
                </div>

                <div
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={async (event) => {
                        event.preventDefault();
                        await consumeFiles(event.dataTransfer.files);
                    }}
                    style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'grid', gap: '12px', paddingRight: '4px' }}
                >
                {unmatchedSubtitleAssets.length > 0 && (
                    <div style={{
                        padding: '16px',
                        borderRadius: '16px',
                        border: '1px solid rgba(250,204,21,0.22)',
                        background: 'rgba(250,204,21,0.08)'
                    }}>
                        <div style={{ color: '#fde68a', fontWeight: 700, marginBottom: '12px' }}>
                            未匹配字幕
                        </div>
                        <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: '0.9em', marginBottom: '12px' }}>
                            以下字幕尚未完成归档。请指定目标视频与字幕类型后再加入批量队列。
                        </div>
                        <div style={{ display: 'grid', gap: '10px' }}>
                            {unmatchedSubtitleAssets.map(asset => {
                                const selection = unmatchedSelections[asset.path];
                                const hint = getSubtitleAssignmentHint(asset, asrOriLang, targetLang);
                                const assignmentValidation = asset.textContent
                                    ? validateSubtitleLanguageFit(
                                        asset.textContent,
                                        selection?.kind === 'subtitle-original' ? asrOriLang : targetLang,
                                        selection?.kind === 'subtitle-original' ? 'source' : 'target'
                                    )
                                    : null;
                                return (
                                    <div
                                        key={asset.path}
                                        style={{
                                            display: 'grid',
                                            gridTemplateColumns: '1.3fr 1fr 0.8fr auto auto',
                                            gap: '10px',
                                            alignItems: 'center',
                                            padding: '12px',
                                            borderRadius: '12px',
                                            background: 'rgba(15,23,42,0.35)',
                                            border: '1px solid rgba(255,255,255,0.08)'
                                        }}
                                    >
                                        <Cell
                                            title="字幕文件"
                                            primary={asset.name}
                                            secondary={asset.path}
                                            badge={hint.reason ? {
                                                label: hint.suggestedKind === 'subtitle-translated'
                                                    ? '译文'
                                                    : hint.suggestedKind === 'subtitle-original'
                                                        ? '原文'
                                                        : '待确认',
                                                color: hint.suggestedKind ? '#93c5fd' : '#fcd34d',
                                                background: hint.suggestedKind ? 'rgba(59,130,246,0.16)' : 'rgba(245,158,11,0.16)'
                                                } : undefined}
                                            footer={assignmentValidation && !assignmentValidation.ok ? assignmentValidation.reason : undefined}
                                        />
                                        <div>
                                            <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.78em', marginBottom: '4px' }}>目标视频</div>
                                            <select
                                                value={selection?.itemId || ''}
                                                onChange={(event) => {
                                                    const itemId = event.target.value;
                                                    setManualAssignments(prev => ({
                                                        ...prev,
                                                        [asset.path]: {
                                                            itemId,
                                                            kind: prev[asset.path]?.kind || getSubtitleKind(asset)
                                                        }
                                                    }));
                                                }}
                                                style={selectStyle}
                                            >
                                                {items.map(item => (
                                                    <option key={item.id} value={item.id}>{item.fileName}</option>
                                                ))}
                                                </select>
                                            {hint.reason && (
                                                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.76em', marginTop: '6px', lineHeight: 1.4 }}>
                                                    {hint.reason}
                                                </div>
                                            )}
                                        </div>
                                        <div>
                                            <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.78em', marginBottom: '4px' }}>字幕类型</div>
                                            <select
                                                value={selection?.kind || getSubtitleKind(asset)}
                                                onChange={(event) => {
                                                    const kind = event.target.value as 'subtitle-original' | 'subtitle-translated';
                                                    setManualAssignments(prev => ({
                                                        ...prev,
                                                        [asset.path]: {
                                                            itemId: prev[asset.path]?.itemId || items[0]?.id || '',
                                                            kind
                                                        }
                                                    }));
                                                }}
                                                style={selectStyle}
                                            >
                                                <option value="subtitle-original">原字幕</option>
                                                <option value="subtitle-translated">翻译字幕</option>
                                            </select>
                                        </div>
                                        <button
                                            onClick={() => {
                                                if (!selection?.itemId) return;
                                                onAssignUnmatchedSubtitle(asset.path, selection.itemId, selection.kind);
                                                setManualAssignments(prev => {
                                                    const next = { ...prev };
                                                    delete next[asset.path];
                                                    return next;
                                                });
                                            }}
                                            disabled={!selection?.itemId || assignmentValidation?.ok === false}
                                            style={buttonStyle('accentSoft', !selection?.itemId || assignmentValidation?.ok === false)}
                                        >
                                            关联
                                        </button>
                                        <button
                                            onClick={() => {
                                                onRemoveUnmatchedSubtitle(asset.path);
                                                setManualAssignments(prev => {
                                                    const next = { ...prev };
                                                    delete next[asset.path];
                                                    return next;
                                                });
                                            }}
                                            style={buttonStyle('secondary')}
                                        >
                                            移除
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                <div style={{ display: 'grid', gap: '12px' }}>
                    {items.length === 0 && (
                        <div style={{ padding: '24px', textAlign: 'center', color: 'rgba(255,255,255,0.6)' }}>
                            暂无任务
                        </div>
                    )}

                    {items.map(item => (
                        <div
                            key={item.id}
                            style={{
                                display: 'grid',
                                gap: '10px',
                                padding: '14px 16px',
                                borderRadius: '14px',
                                background: 'rgba(15, 23, 42, 0.45)',
                                border: '1px solid rgba(255,255,255,0.08)'
                            }}
                        >
                            <div style={{
                                display: 'grid',
                                gridTemplateColumns: 'minmax(0, 1.4fr) minmax(180px, 0.8fr) auto auto auto',
                                gap: '12px',
                                alignItems: 'center'
                            }}>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ color: '#fff', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {item.fileName}
                                    </div>
                                    <div style={{ color: 'rgba(255,255,255,0.56)', fontSize: '0.82em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '4px' }}>
                                        {item.stage}
                                    </div>
                                </div>

                                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                                    {getCompactBadges(item).map((badge) => (
                                        <span
                                            key={badge.label}
                                            style={{
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                padding: '3px 9px',
                                                borderRadius: '999px',
                                                fontSize: '0.74em',
                                                fontWeight: 700,
                                                color: badge.color,
                                                background: badge.background,
                                                whiteSpace: 'nowrap'
                                            }}
                                        >
                                            {badge.label}
                                        </span>
                                    ))}
                                </div>

                                <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: '0.86em', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                    <div>{formatDuration(item.sourceDurationSec)}</div>
                                    <div style={{ marginTop: '4px', color: 'rgba(255,255,255,0.5)' }}>{formatItemElapsed(item, summary.nowEpochMs)}</div>
                                </div>

                                <div>
                                    <span style={{
                                        display: 'inline-flex',
                                        padding: '4px 10px',
                                        borderRadius: '999px',
                                        color: '#fff',
                                        background: statusColor[item.status],
                                        fontSize: '0.8em',
                                        fontWeight: 600,
                                        whiteSpace: 'nowrap'
                                    }}>
                                        {statusLabel(item.status)}
                                    </span>
                                </div>

                                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center' }}>
                                    {hasSecondaryInfo(item) && (
                                        <button
                                            onClick={() => setExpandedItems(prev => ({ ...prev, [item.id]: !prev[item.id] }))}
                                            style={buttonStyle('secondary')}
                                        >
                                            {expandedItems[item.id] ? '收起' : '详情'}
                                        </button>
                                    )}
                                    {item.outputPath && (
                                        <button onClick={() => onOpenOutput(item)} style={buttonStyle('accentSoft')}>
                                            打开输出
                                        </button>
                                    )}
                                    <button
                                        onClick={() => onRemoveItem(item.id)}
                                        disabled={item.status === 'processing'}
                                        style={buttonStyle('secondary', item.status === 'processing')}
                                    >
                                        移除
                                    </button>
                                </div>
                            </div>

                            {expandedItems[item.id] && hasSecondaryInfo(item) && (
                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                                    gap: '12px',
                                    paddingTop: '10px',
                                    borderTop: '1px solid rgba(255,255,255,0.08)'
                                }}>
                                    <Cell
                                        title="原字幕"
                                        primary={displayName(item.originalSubtitlePath)}
                                        secondary={item.originalSubtitlePath}
                                        emptyText="待生成"
                                        badge={getSourceSubtitleBadge(item)}
                                    />
                                    <Cell
                                        title="翻译字幕"
                                        primary={displayName(item.translatedSubtitlePath)}
                                        secondary={item.translatedSubtitlePath}
                                        emptyText="待生成"
                                        badge={getTranslatedSubtitleBadge(item)}
                                    />
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.78em', marginBottom: '4px' }}>任务信息</div>
                                        {item.resumeInfo && (
                                            <div style={{ color: 'rgba(255,255,255,0.68)', fontSize: '0.82em', lineHeight: 1.55 }}>
                                                {formatResumeSummary(item)}
                                            </div>
                                        )}
                                        {item.outputPath && <div style={{ marginTop: '6px', color: '#93c5fd', fontSize: '0.82em' }}>成片已输出</div>}
                                        {item.errorInfo && (
                                            <div
                                                title={summarizeStructuredError(item.errorInfo)}
                                                style={{
                                                    marginTop: '6px',
                                                    color: '#fca5a5',
                                                    fontSize: '0.82em',
                                                    lineHeight: 1.5
                                                }}
                                            >
                                                {summarizeStructuredError(item.errorInfo)}
                                            </div>
                                        )}
                                        {item.errorInfo?.detail && (
                                            <div style={{ marginTop: '4px', color: 'rgba(255,255,255,0.5)', fontSize: '0.78em', lineHeight: 1.5 }}>
                                                {truncateText(item.errorInfo.detail, 120)}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
                </div>
            </div>
        </div>
    );
}

function truncateText(value: string, maxLength: number) {
    const compact = value.replace(/\s+/g, ' ').trim();
    return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
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

function Cell({
    title,
    primary,
    secondary,
    emptyText,
    badge,
    footer
}: {
    title: string;
    primary?: string;
    secondary?: string;
    emptyText?: string;
    badge?: { label: string; color: string; background: string };
    footer?: string;
}) {
    return (
        <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', minWidth: 0 }}>
                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.78em' }}>{title}</div>
                {badge && (
                    <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '2px 8px',
                        borderRadius: '999px',
                        fontSize: '0.72em',
                        fontWeight: 700,
                        color: badge.color,
                        background: badge.background,
                        whiteSpace: 'nowrap'
                    }}>
                        {badge.label}
                    </span>
                )}
            </div>
            <div style={{ color: '#fff', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {primary || emptyText || '未设置'}
            </div>
            {secondary && (
                <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.82em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {secondary}
                </div>
            )}
            {footer && (
                <div style={{ marginTop: '6px', color: '#fca5a5', fontSize: '0.78em', lineHeight: 1.45 }}>
                    {footer}
                </div>
            )}
        </div>
    );
}

function getSourceSubtitleBadge(item: BatchQueueItem) {
    if (item.originalSubtitlePath || item.originalSubtitleContent) {
        return {
            label: '字幕已生成',
            color: '#86efac',
            background: 'rgba(34,197,94,0.16)'
        };
    }

    if (item.status === 'processing' && item.stageKey === BATCH_QUEUE_STAGE.sourceSubtitleGenerating) {
        return {
            label: '识别中',
            color: '#93c5fd',
            background: 'rgba(59,130,246,0.16)'
        };
    }

    return undefined;
}

function getTranslatedSubtitleBadge(item: BatchQueueItem) {
    if (item.translatedSubtitlePath || item.translatedSubtitleContent) {
        return {
            label: '翻译已生成',
            color: '#fcd34d',
            background: 'rgba(245,158,11,0.16)'
        };
    }

    if (item.status === 'processing' && item.stageKey === BATCH_QUEUE_STAGE.translatingSubtitles) {
        return {
            label: '翻译中',
            color: '#93c5fd',
            background: 'rgba(59,130,246,0.16)'
        };
    }

    return undefined;
}

function getCompactBadges(item: BatchQueueItem) {
    const badges: Array<{ label: string; color: string; background: string }> = [];
    const sourceBadge = getSourceSubtitleBadge(item);
    const translatedBadge = getTranslatedSubtitleBadge(item);

    if (sourceBadge) badges.push(sourceBadge);
    if (translatedBadge) badges.push(translatedBadge);
    if (item.resumeInfo?.recoverable) {
        badges.push({
            label: '可续跑',
            color: '#7dd3fc',
            background: 'rgba(56,189,248,0.16)'
        });
    }
    if (item.errorInfo) {
        badges.push({
            label: '异常',
            color: '#fca5a5',
            background: 'rgba(248,113,113,0.16)'
        });
    }
    if (item.outputPath) {
        badges.push({
            label: '已输出',
            color: '#93c5fd',
            background: 'rgba(59,130,246,0.16)'
        });
    }

    return badges.slice(0, 4);
}

function hasSecondaryInfo(item: BatchQueueItem) {
    return Boolean(
        item.resumeInfo ||
        item.errorInfo ||
        item.outputPath ||
        item.originalSubtitlePath ||
        item.translatedSubtitlePath
    );
}

function formatResumeSummary(item: BatchQueueItem) {
    const resumeInfo = item.resumeInfo;
    if (!resumeInfo) return '';

    const parts = [];
    if (resumeInfo.recoverable) {
        parts.push('可续跑');
    }
    if (resumeInfo.canReuseSourceSubtitles) {
        parts.push('复用原字幕');
    }
    if (resumeInfo.canReuseTranslatedSubtitles) {
        parts.push('复用译文');
    }
    if (resumeInfo.canResumeDubbing) {
        parts.push(`保留音频 ${resumeInfo.preservedAudioSegments} 段`);
    }
    if (resumeInfo.canResumeMerge) {
        parts.push('可直接继续合成');
    }
    if (resumeInfo.blockedReason) {
        parts.push(`续跑受限: ${resumeInfo.blockedReason}`);
    }
    return parts.join(' · ');
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
    if (item.status === 'processing' && item.startedAt) {
        return formatElapsed(Math.max(0, nowEpochMs - item.startedAt));
    }
    return '--';
}

function buttonStyle(variant: 'accent' | 'accentSoft' | 'success' | 'secondary' | 'danger', disabled = false): React.CSSProperties {
    const styles = {
        accent: {
            background: 'linear-gradient(180deg, rgba(91, 97, 246, 0.96), rgba(76, 83, 227, 0.96))',
            border: '1px solid rgba(110, 116, 255, 0.32)',
            color: '#f8fbff',
            boxShadow: '0 10px 24px rgba(76, 83, 227, 0.18)'
        },
        accentSoft: {
            background: 'rgba(59, 130, 246, 0.14)',
            border: '1px solid rgba(96, 165, 250, 0.22)',
            color: '#dbeafe',
            boxShadow: 'none'
        },
        success: {
            background: 'linear-gradient(180deg, rgba(17, 163, 118, 0.94), rgba(6, 128, 94, 0.94))',
            border: '1px solid rgba(52, 211, 153, 0.24)',
            color: '#f8fbff',
            boxShadow: '0 10px 24px rgba(6, 128, 94, 0.16)'
        },
        secondary: {
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(148,163,184,0.16)',
            color: '#eff6ff',
            boxShadow: 'none'
        },
        danger: {
            background: 'rgba(220, 38, 38, 0.18)',
            border: '1px solid rgba(248, 113, 113, 0.24)',
            color: '#fee2e2',
            boxShadow: 'none'
        }
    } satisfies Record<string, { background: string; border: string; color: string; boxShadow: string }>;

    const current = styles[variant];
    return {
        padding: '10px 16px',
        borderRadius: '10px',
        border: current.border,
        background: current.background,
        color: current.color,
        boxShadow: current.boxShadow,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.18s ease, border-color 0.18s ease, opacity 0.18s ease'
    };
}

const selectStyle: React.CSSProperties = {
    width: '100%',
    padding: '9px 10px',
    borderRadius: '10px',
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(15,23,42,0.9)',
    color: '#fff'
};

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
