import React, { useEffect, useRef } from 'react';
import { runBackendCommand } from '../utils/backendCommandClient';
import { Segment } from './Timeline';
import { buildCheckAudioFilesCommand } from '../utils/backendCommandBuilders';
import { TARGET_LANGUAGE_OPTIONS } from '../utils/languageTags';

export interface TranslationPanelProps {
    segments: Segment[];
    translatedSegments: Segment[];
    setTranslatedSegments: React.Dispatch<React.SetStateAction<Segment[]>>;
    onUpdateTranslatedSegment: (index: number, text: string) => void;
    targetLang: string;
    setTargetLang: (lang: string) => void;
    onTranslate: () => void;
    domRef?: React.RefObject<HTMLDivElement>;
    onScroll?: () => void;
    currentTime?: number;
    onGenerateAll?: () => void;
    onTranslateAndDub?: () => void;
    onGenerateSingle?: (index: number) => void;
    onPlayAudio?: (index: number, path: string) => void;
    generatingSegmentId?: number | null;
    retranslatingSegmentId?: number | null;
    dubbingLoading?: boolean;
    onReTranslate?: (index: number) => void;
    loading?: boolean;
    translationBusy?: boolean;
    playingAudioIndex?: number | null;
    activeIndex?: number;
    onEditStart?: (index: number) => void;
    onEditEnd?: () => void;
    onUploadSubtitle?: (file: File) => void;
    hasVideo?: boolean;
    ttsService?: string;
    hasErrors?: boolean;
    onRetryErrors?: () => void;
    onExport?: () => void;
}

const TranslationPanel: React.FC<TranslationPanelProps> = ({
    segments,
    translatedSegments,
    setTranslatedSegments,
    onUpdateTranslatedSegment,
    targetLang,
    setTargetLang,
    onTranslate,
    domRef,
    onScroll,
    currentTime = 0,
    onGenerateAll,
    onTranslateAndDub,
    onGenerateSingle,
    onPlayAudio,
    generatingSegmentId,
    retranslatingSegmentId,
    dubbingLoading,
    onReTranslate,
    loading,
    translationBusy,
    playingAudioIndex,
    activeIndex,
    onEditStart,
    onEditEnd,
    onUploadSubtitle,
    hasVideo = false,
    onExport
}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const primaryControlHeight = 30;
    const secondaryControlHeight = 29;
    const actionBlockHeight = 64;
    const hasSourceSegments = segments.length > 0;
    const hasTranslatedSegments = translatedSegments.length > 0;
    const translateDisabled = !hasSourceSegments || loading || dubbingLoading;
    const generateDisabled = !hasTranslatedSegments || dubbingLoading || loading || generatingSegmentId !== null;
    const importDisabled = !hasVideo || loading || dubbingLoading;
    const translateAndDubDisabled = !hasSourceSegments || loading || dubbingLoading;

    const secondaryButtonStyle: React.CSSProperties = {
        padding: '6px 12px',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        height: 'fit-content',
        fontSize: '0.9em'
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            if (file.name.endsWith('.srt')) {
                onUploadSubtitle?.(file);
            }
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const formatTimestamp = (seconds: number): string => {
        if (seconds < 60) {
            return `${seconds.toFixed(2)}s`;
        }
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
    };

    const internalRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

    const listRef = domRef || internalRef;

    const activeIdx = activeIndex !== undefined
        ? activeIndex
        : segments.findIndex(seg => currentTime >= seg.start && currentTime < seg.end);

    useEffect(() => {
        if (activeIdx !== -1 && itemRefs.current[activeIdx]) {
            itemRefs.current[activeIdx]?.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });
        }
    }, [activeIdx]);

    return (
        <div
            className="glass-panel"
            style={{
                height: '100%',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                padding: '12px',
                gap: '10px'
            }}
        >
            <div
                style={{
                    flex: '0 0 auto',
                    background: 'rgba(255,255,255,0.03)',
                    padding: '13px 14px',
                    borderRadius: '12px',
                    border: '1px solid rgba(255,255,255,0.06)',
                    minHeight: '112px',
                    boxSizing: 'border-box',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center'
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', minHeight: '86px' }}>
                    <div style={{ flex: '0 0 auto', minWidth: 0, display: 'flex', alignItems: 'center' }}>
                        <h3 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.02rem', lineHeight: 1.25 }}>3. 翻译字幕</h3>
                    </div>
                    <div style={{ width: '520px', maxWidth: '74%', minWidth: 0, height: `${actionBlockHeight}px`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div style={{ display: 'grid', gridTemplateRows: `${primaryControlHeight}px ${secondaryControlHeight}px`, rowGap: '5px', alignContent: 'center', width: '100%', maxWidth: '436px' }}>
                        <input
                            type="file"
                            accept=".srt"
                            ref={fileInputRef}
                            style={{ display: 'none' }}
                            onChange={(e) => {
                                if (e.target.files && e.target.files.length > 0) {
                                    onUploadSubtitle?.(e.target.files[0]);
                                    e.target.value = '';
                                }
                            }}
                        />
                        <div style={{ display: 'flex', width: '100%' }}>
                            <button
                                onClick={() => onTranslateAndDub?.()}
                                disabled={translateAndDubDisabled}
                                className="btn"
                                style={{
                                    padding: '6px 12px',
                                    background: translateAndDubDisabled ? '#4b5563' : '#6366f1',
                                    fontSize: '0.9em',
                                    height: `${primaryControlHeight}px`,
                                    cursor: translateAndDubDisabled ? 'not-allowed' : 'pointer',
                                    opacity: translateAndDubDisabled ? 0.7 : 1,
                                    whiteSpace: 'nowrap',
                                    width: '100%'
                                }}
                            >
                                翻译并生成配音
                            </button>
                        </div>
                        <div style={{ display: 'flex', width: '100%' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '96px 54px 72px 44px 44px 44px', columnGap: '4px', alignItems: 'center', minWidth: 0, width: '100%', justifyContent: 'space-between' }}>
                            <select
                                style={{
                                    width: '96px',
                                    minWidth: '96px',
                                    padding: '7px 8px',
                                    height: `${secondaryControlHeight}px`,
                                    background: 'var(--bg-primary)',
                                    color: 'var(--text-primary)',
                                    border: '1px solid var(--border-color)',
                                    borderRadius: '8px'
                                }}
                                value={targetLang}
                                onChange={(e) => setTargetLang(e.target.value)}
                            >
                                {TARGET_LANGUAGE_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                            </select>
                            <button
                                onClick={() => onTranslate()}
                                disabled={translateDisabled}
                                className="btn"
                                style={{
                                    padding: '7px 8px',
                                    height: `${secondaryControlHeight}px`,
                                    background: translateDisabled ? '#4b5563' : '#2563eb',
                                    cursor: translateDisabled ? 'not-allowed' : 'pointer',
                                    opacity: translateDisabled ? 0.7 : 1,
                                    width: '54px',
                                    minWidth: '54px'
                                }}
                            >
                                {translationBusy ? '翻译中...' : '翻译'}
                            </button>
                            <button
                                onClick={onGenerateAll}
                                disabled={generateDisabled}
                                className="btn"
                                style={{
                                    padding: '7px 8px',
                                    height: `${secondaryControlHeight}px`,
                                    background: generateDisabled ? '#4b5563' : '#10b981',
                                    fontSize: '0.85em',
                                    cursor: generateDisabled ? 'not-allowed' : 'pointer',
                                    opacity: generateDisabled ? 0.7 : 1,
                                    whiteSpace: 'nowrap',
                                    width: '72px',
                                    minWidth: '72px'
                                }}
                            >
                                {dubbingLoading ? '处理中...' : (generatingSegmentId !== null ? '单个生成中...' : '生成配音')}
                            </button>
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                onDrop={handleDrop}
                                onDragOver={handleDragOver}
                                className="btn"
                                disabled={importDisabled}
                                title={!hasVideo ? '请先导入视频' : '点击上传或拖拽 SRT 文件'}
                                style={{
                                    ...secondaryButtonStyle,
                                    padding: '7px 8px',
                                    height: `${secondaryControlHeight}px`,
                                    fontSize: '0.82em',
                                    border: importDisabled ? '1px dashed #6b7280' : secondaryButtonStyle.border,
                                    color: importDisabled ? '#9ca3af' : secondaryButtonStyle.color,
                                    cursor: importDisabled ? 'not-allowed' : 'pointer',
                                    opacity: importDisabled ? 0.7 : 1,
                                    width: '44px',
                                    minWidth: '44px'
                                }}
                            >
                                导入
                            </button>
                            <button
                                onClick={onExport}
                                disabled={!onExport || !hasTranslatedSegments}
                                className="btn"
                                title="导出翻译字幕"
                                style={{
                                    ...secondaryButtonStyle,
                                    padding: '7px 8px',
                                    height: `${secondaryControlHeight}px`,
                                    fontSize: '0.82em',
                                    border: (!onExport || !hasTranslatedSegments) ? '1px dashed #6b7280' : secondaryButtonStyle.border,
                                    color: (!onExport || !hasTranslatedSegments) ? '#9ca3af' : secondaryButtonStyle.color,
                                    cursor: (!onExport || !hasTranslatedSegments) ? 'not-allowed' : 'pointer',
                                    width: '44px',
                                    minWidth: '44px'
                                }}
                            >
                                导出
                            </button>
                            <button
                                onClick={async () => {
                                    if (!hasTranslatedSegments) return;
                                    const paths = translatedSegments.map(s => s.audioPath).filter(p => p);
                                    if (paths.length === 0) return;

                                    try {
                                        const result = await runBackendCommand(buildCheckAudioFilesCommand(JSON.stringify(paths)));

                                        if (result && result.success && result.durations) {
                                            const durations = result.durations;
                                            setTranslatedSegments(prev => prev.map(seg => {
                                                const newSeg = { ...seg };

                                                if (seg.audioPath && durations[seg.audioPath] !== undefined) {
                                                    const dur = durations[seg.audioPath];
                                                    if (dur < 0) {
                                                        newSeg.audioStatus = 'error';
                                                        newSeg.audioDuration = undefined;
                                                    } else {
                                                        newSeg.audioDuration = dur;
                                                        if (dur - (seg.end - seg.start) > 5.0) {
                                                            newSeg.audioStatus = 'error';
                                                        }
                                                    }
                                                } else if (seg.audioStatus === 'ready' && !seg.audioPath) {
                                                    newSeg.audioStatus = 'error';
                                                }

                                                return newSeg;
                                            }));
                                        }
                                    } catch (e) {
                                        console.error(e);
                                    }
                                }}
                                className="btn"
                                style={{
                                    ...secondaryButtonStyle,
                                    padding: '7px 8px',
                                    height: `${secondaryControlHeight}px`,
                                    fontSize: '0.82em',
                                    border: !hasTranslatedSegments ? '1px dashed #6b7280' : secondaryButtonStyle.border,
                                    color: !hasTranslatedSegments ? '#9ca3af' : secondaryButtonStyle.color,
                                    cursor: !hasTranslatedSegments ? 'not-allowed' : 'pointer',
                                    width: '44px',
                                    minWidth: '44px'
                                }}
                                title="扫描本地文件并更新状态"
                                disabled={!hasTranslatedSegments}
                            >
                                校验
                            </button>
                            </div>

                        </div>
                        </div>
                    </div>
                </div>
            </div>

            <div
                style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', paddingRight: '4px' }}
                onScroll={onScroll}
                ref={listRef}
            >
                {(translatedSegments.length > 0 ? translatedSegments : segments).map((seg, idx) => {
                    const isTranslated = translatedSegments.length > 0;
                    const isActive = idx === activeIdx;
                    const isGenerating = generatingSegmentId === idx;
                    const isRetranslating = retranslatingSegmentId === idx;
                    const isBusy = isGenerating || isRetranslating;

                    let bgColor = 'var(--bg-secondary)';
                    let borderColor = 'transparent';

                    if (isBusy) {
                        bgColor = 'rgba(245, 158, 11, 0.2)';
                        borderColor = '#f59e0b';
                    } else if (isActive) {
                        bgColor = 'rgba(99,102,241, 0.3)';
                        borderColor = '#6366f1';
                    }

                    const durationTooLong = Boolean(seg.audioDuration && (seg.audioDuration - (seg.end - seg.start) > 5.0));

                    return (
                        <div
                            key={idx}
                            ref={el => { itemRefs.current[idx] = el; }}
                            style={{
                                display: 'flex',
                                gap: '10px',
                                alignItems: 'center',
                                background: bgColor,
                                padding: '10px',
                                borderRadius: '6px',
                                borderLeft: `4px solid ${borderColor}`,
                                transition: 'all 0.3s ease',
                                opacity: isTranslated ? 1 : 0.5,
                                minHeight: '52px',
                                boxSizing: 'border-box',
                                cursor: 'pointer'
                            }}
                        >
                            <div style={{ minWidth: '40px', fontSize: '0.85em', color: 'var(--text-secondary)', userSelect: 'none', textAlign: 'center' }}>
                                {idx + 1}
                            </div>
                            <div style={{ minWidth: '120px', fontSize: '0.85em', color: isActive ? 'var(--text-primary)' : 'var(--accent-color)' }}>
                                {formatTimestamp(seg.start)} - {formatTimestamp(seg.end)}
                            </div>

                            {isTranslated ? (
                                <>
                                    <input
                                        className="input-field"
                                        value={seg.text}
                                        onClick={(e) => e.stopPropagation()}
                                        onFocus={() => onEditStart?.(idx)}
                                        onBlur={() => onEditEnd?.()}
                                        onChange={(e) => onUpdateTranslatedSegment(idx, e.target.value)}
                                        style={{ flex: 1, background: 'transparent', border: 'none', color: 'inherit' }}
                                    />
                                    <div style={{ display: 'flex', gap: '5px', alignItems: 'center', flexShrink: 0 }}>
                                        {seg.audioStatus === 'generating' && <span title="生成中">⏳</span>}
                                        {(seg.audioStatus === 'error' || durationTooLong) && <span title="生成失败">❌</span>}
                                        {seg.audioStatus === 'ready' && !durationTooLong && <span title="已生成">✅</span>}

                                        {seg.audioPath && (
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onPlayAudio?.(idx, seg.audioPath!);
                                                }}
                                                className="btn-icon"
                                                title="播放配音"
                                                style={{
                                                    padding: '2px 5px',
                                                    fontSize: '0.8em',
                                                    background: '#3b82f6',
                                                    border: 'none',
                                                    borderRadius: '4px',
                                                    cursor: 'pointer',
                                                    color: 'white'
                                                }}
                                            >
                                                {playingAudioIndex === idx ? '⏸' : '▶'}
                                            </button>
                                        )}

                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onGenerateSingle?.(idx);
                                            }}
                                            disabled={generatingSegmentId !== null || loading || dubbingLoading}
                                            className="btn-icon"
                                            title="重新生成配音"
                                            style={{
                                                padding: '2px 5px',
                                                fontSize: '0.8em',
                                                background: (generatingSegmentId !== null || loading || dubbingLoading) ? '#4b5563' : '#f59e0b',
                                                border: 'none',
                                                borderRadius: '4px',
                                                cursor: (generatingSegmentId !== null || loading || dubbingLoading) ? 'not-allowed' : 'pointer',
                                                color: 'white'
                                            }}
                                        >
                                            {generatingSegmentId === idx ? '...' : '🔁'}
                                        </button>

                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onReTranslate?.(idx);
                                            }}
                                            disabled={loading || dubbingLoading || generatingSegmentId !== null}
                                            title="重新翻译"
                                            style={{
                                                background: 'transparent',
                                                border: 'none',
                                                color: (loading || dubbingLoading || generatingSegmentId !== null) ? '#4b5563' : 'var(--text-secondary)',
                                                cursor: (loading || dubbingLoading || generatingSegmentId !== null) ? 'not-allowed' : 'pointer',
                                                padding: '4px',
                                                fontSize: '1em',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                marginLeft: '5px'
                                            }}
                                        >
                                            ↻
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <div style={{ flex: 1, color: '#6b7280', fontStyle: 'italic' }}>
                                    (等待翻译...)
                                </div>
                            )}
                        </div>
                    );
                })}

                {segments.length === 0 && <div style={{ padding: '20px', textAlign: 'center', color: '#6b7280' }}>暂无字幕数据</div>}
            </div>
        </div>
    );
};

export default TranslationPanel;
