import React from 'react';

export interface Segment {
    start: number;
    end: number;
    text: string;
    audioPath?: string;
    audioDuration?: number; // Duration of the generated audio in seconds
    audioStatus?: 'none' | 'generating' | 'ready' | 'error' | 'pending';
}

interface TimelineProps {
    segments: Segment[];
    onUpdateSegment: (index: number, text: string) => void;
    onUpdateSegmentTiming: (index: number, start: number, end: number) => void;
    currentTime?: number;
    onPlaySegment?: (start: number, end: number) => void;
    domRef?: React.RefObject<HTMLDivElement>;
    onScroll?: () => void;
    onASR?: () => void;
    loading?: boolean;
    asrBusy?: boolean;
    videoPath?: string;
    playingVideoIndex?: number | null;
    activeIndex?: number;
    onEditStart?: (index: number) => void;
    onEditEnd?: () => void;
    onUploadSubtitle?: (file: File) => void;
    onExport?: () => void;
}

const formatTimestamp = (seconds: number): string => {
    const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    if (safeSeconds < 60) {
        return `${safeSeconds.toFixed(2)}s`;
    }
    const mins = Math.floor(safeSeconds / 60);
    const secs = safeSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
};

const parseTimestampInput = (value: string): number | null => {
    const normalized = value.trim();
    if (!normalized) return null;
    if (/^\d+(\.\d+)?$/.test(normalized)) {
        const seconds = Number.parseFloat(normalized);
        return Number.isFinite(seconds) ? seconds : null;
    }

    const minuteMatch = normalized.match(/^(\d{1,3}):(\d{2}(?:\.\d+)?)$/);
    if (minuteMatch) {
        const minutes = Number.parseInt(minuteMatch[1], 10);
        const seconds = Number.parseFloat(minuteMatch[2]);
        if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
            return null;
        }
        return (minutes * 60) + seconds;
    }

    const match = normalized.match(/^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/);
    if (!match) return null;

    const hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);
    const seconds = Number.parseFloat(match[3]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
        return null;
    }
    return (hours * 3600) + (minutes * 60) + seconds;
};

const Timeline: React.FC<TimelineProps> = ({ segments, onUpdateSegment, onUpdateSegmentTiming, currentTime = 0, onPlaySegment, domRef, onScroll, onASR, loading, asrBusy, videoPath, playingVideoIndex, activeIndex, onEditStart, onEditEnd, onUploadSubtitle, onExport }) => {
    const internalRef = React.useRef<HTMLDivElement>(null);
    const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
    const [timeDrafts, setTimeDrafts] = React.useState<Record<number, { start: string; end: string }>>({});
    const primaryControlHeight = 30;
    const secondaryControlHeight = 29;
    const actionBlockHeight = 64;

    // Use passed ref or internal fallback
    const listRef = domRef || internalRef;

    // Use passed activeIndex or calculate local fallback
    const activeIdx = activeIndex !== undefined
        ? activeIndex
        : segments.findIndex(seg => currentTime >= seg.start && currentTime < seg.end);

    React.useEffect(() => {
        if (activeIdx !== -1 && itemRefs.current[activeIdx]) {
            // Only scroll if we are not actively interacting? Or just let it scroll.
            // Simplified for now.
            itemRefs.current[activeIdx]?.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });
        }
    }, [activeIdx]);

    React.useEffect(() => {
        setTimeDrafts((prev) => {
            const next: Record<number, { start: string; end: string }> = {};
            for (const [key, draft] of Object.entries(prev)) {
                const numericKey = Number.parseInt(key, 10);
                if (!Number.isFinite(numericKey) || !segments[numericKey]) continue;
                next[numericKey] = draft;
            }
            return next;
        });
    }, [segments]);

    const commitTimingChange = (index: number) => {
        const draft = timeDrafts[index];
        const segment = segments[index];
        if (!draft || !segment) return;

        const nextStart = parseTimestampInput(draft.start);
        const nextEnd = parseTimestampInput(draft.end);
        if (nextStart === null || nextEnd === null || nextEnd <= nextStart) {
            setTimeDrafts(prev => ({
                ...prev,
                [index]: {
                    start: formatTimestamp(segment.start),
                    end: formatTimestamp(segment.end)
                }
            }));
            return;
        }

        onUpdateSegmentTiming(index, nextStart, nextEnd);
        setTimeDrafts(prev => {
            const next = { ...prev };
            delete next[index];
            return next;
        });
    };

    return (
        <div
            className="glass-panel"
            style={{
                textAlign: 'left',
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
                    padding: '14px 14px 12px',
                    borderRadius: '12px',
                    border: '1px solid rgba(255,255,255,0.06)',
                    minHeight: '112px',
                    boxSizing: 'border-box',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center'
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '4px', flex: 1, minWidth: 0 }}>
                        <h3 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.02rem', lineHeight: 1.25 }}>2. 编辑字幕</h3>
                        <div style={{ color: 'var(--text-primary)', lineHeight: '1.35', fontSize: '0.95rem', fontWeight: 600 }}>
                            时间轴编辑与片段校对
                        </div>
                    </div>
                    <div style={{ width: '168px', minWidth: '168px', height: `${actionBlockHeight}px`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div style={{ width: '100%', display: 'grid', gridTemplateRows: `${primaryControlHeight}px ${secondaryControlHeight}px`, rowGap: '5px', alignContent: 'center' }}>
                            {onASR && (
                                <button
                                    className="btn"
                                    onClick={onASR}
                                    disabled={loading || !videoPath}
                                    style={{
                                        padding: '6px 12px',
                                        fontSize: '0.9em',
                                        background: loading || !videoPath ? '#4b5563' : 'linear-gradient(180deg, rgba(91, 97, 246, 0.96), rgba(76, 83, 227, 0.96))',
                                        border: loading || !videoPath ? '1px solid rgba(107, 114, 128, 0.4)' : '1px solid rgba(110, 116, 255, 0.32)',
                                        cursor: loading || !videoPath ? 'not-allowed' : 'pointer',
                                        opacity: loading || !videoPath ? 0.7 : 1,
                                        whiteSpace: 'nowrap',
                                        height: `${primaryControlHeight}px`,
                                        width: '100%'
                                    }}
                                >
                                    {asrBusy ? '识别中...' : '生成字幕'}
                                </button>
                            )}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '5px', width: '100%' }}>
                                {onExport && (
                                    <button
                                        disabled={segments.length === 0}
                                        onClick={onExport}
                                        className="btn"
                                        title="导出字幕文件"
                                        style={{
                                            padding: '5px 12px',
                                            fontSize: '0.9em',
                                            background: 'rgba(255,255,255,0.04)',
                                            border: segments.length === 0 ? '1px dashed #6b7280' : '1px solid rgba(148, 163, 184, 0.16)',
                                            color: segments.length === 0 ? '#9ca3af' : '#eff6ff',
                                            cursor: segments.length === 0 ? 'not-allowed' : 'pointer',
                                            whiteSpace: 'nowrap',
                                            height: `${secondaryControlHeight}px`,
                                            width: '100%'
                                        }}
                                    >
                                        导出字幕
                                    </button>
                                )}
                                {onUploadSubtitle && (
                                    <>
                                        <input
                                            type="file"
                                            accept=".srt"
                                            id="timeline-upload-input"
                                            style={{ display: 'none' }}
                                            onChange={(e) => {
                                                if (e.target.files?.[0]) {
                                                    onUploadSubtitle(e.target.files[0]);
                                                    e.target.value = '';
                                                }
                                            }}
                                        />
                                        <button
                                            disabled={!videoPath}
                                            onClick={() => document.getElementById('timeline-upload-input')?.click()}
                                            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                            onDrop={(e) => {
                                                e.preventDefault(); e.stopPropagation();
                                                if (e.dataTransfer.files?.[0] && onUploadSubtitle) {
                                                    onUploadSubtitle(e.dataTransfer.files[0]);
                                                }
                                            }}
                                            className="btn"
                                            title="导入字幕文件"
                                            style={{
                                                padding: '5px 12px',
                                                fontSize: '0.9em',
                                                background: 'rgba(255,255,255,0.04)',
                                                border: !videoPath ? '1px dashed #6b7280' : '1px solid rgba(148, 163, 184, 0.16)',
                                                color: !videoPath ? '#9ca3af' : '#eff6ff',
                                                cursor: !videoPath ? 'not-allowed' : 'pointer',
                                                whiteSpace: 'nowrap',
                                                height: `${secondaryControlHeight}px`,
                                                width: '100%'
                                            }}
                                        >
                                            导入字幕
                                        </button>
                                    </>
                                )}
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
                {segments.map((seg, idx) => {
                    const isActive = idx === activeIdx;
                    return (
                        <div
                            key={idx}
                            ref={el => itemRefs.current[idx] = el}
                            style={{
                                display: 'flex',
                                gap: '10px',
                                alignItems: 'center',
                                background: isActive ? 'rgba(99,102,241, 0.3)' : 'var(--bg-secondary)', // Use bg-secondary instead of rgba(255,255,255,0.05) for better contrast
                                padding: '10px',
                                borderRadius: '6px',
                                borderLeft: isActive ? '4px solid #6366f1' : '4px solid transparent',
                                transition: 'all 0.3s ease',
                                minHeight: '52px',
                                boxSizing: 'border-box'
                            }}
                        >
                            <div style={{ minWidth: '40px', fontSize: '0.85em', color: 'var(--text-secondary)', userSelect: 'none', textAlign: 'center' }}>
                                {idx + 1}
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    setTimeDrafts(prev => ({
                                        ...prev,
                                        [idx]: {
                                            start: prev[idx]?.start ?? formatTimestamp(seg.start),
                                            end: prev[idx]?.end ?? formatTimestamp(seg.end)
                                        }
                                    }));
                                }}
                                style={{
                                    minWidth: '152px',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '6px',
                                    padding: '8px 10px',
                                    borderRadius: '8px',
                                    background: 'rgba(255,255,255,0.03)',
                                    border: '1px solid rgba(255,255,255,0.06)',
                                    color: isActive ? 'var(--text-primary)' : 'var(--accent-color)',
                                    fontSize: '0.92em',
                                    cursor: 'pointer'
                                }}
                                title="编辑开始和结束时间"
                            >
                                <input
                                    className="input-field"
                                    value={timeDrafts[idx]?.start ?? formatTimestamp(seg.start)}
                                    onFocus={() => onEditStart?.(idx)}
                                    onBlur={() => {
                                        commitTimingChange(idx);
                                        onEditEnd?.();
                                    }}
                                    onChange={(e) => {
                                        const value = e.target.value;
                                        setTimeDrafts(prev => ({
                                            ...prev,
                                            [idx]: {
                                                start: value,
                                                end: prev[idx]?.end ?? formatTimestamp(seg.end)
                                            }
                                        }));
                                    }}
                                    style={{
                                        width: '56px',
                                        fontSize: '0.92em',
                                        padding: 0,
                                        border: 'none',
                                        background: 'transparent',
                                        textAlign: 'right',
                                        color: 'inherit'
                                    }}
                                    title="开始时间"
                                />
                                <span style={{ color: 'var(--text-secondary)', userSelect: 'none' }}>-</span>
                                <input
                                    className="input-field"
                                    value={timeDrafts[idx]?.end ?? formatTimestamp(seg.end)}
                                    onFocus={() => onEditStart?.(idx)}
                                    onBlur={() => {
                                        commitTimingChange(idx);
                                        onEditEnd?.();
                                    }}
                                    onChange={(e) => {
                                        const value = e.target.value;
                                        setTimeDrafts(prev => ({
                                            ...prev,
                                            [idx]: {
                                                start: prev[idx]?.start ?? formatTimestamp(seg.start),
                                                end: value
                                            }
                                        }));
                                    }}
                                    style={{
                                        width: '56px',
                                        fontSize: '0.92em',
                                        padding: 0,
                                        border: 'none',
                                        background: 'transparent',
                                        textAlign: 'left',
                                        color: 'inherit'
                                    }}
                                    title="结束时间"
                                />
                            </button>
                            <input
                                className="input-field"
                                value={seg.text}
                                onChange={(e) => onUpdateSegment(idx, e.target.value)}
                                onFocus={() => onEditStart?.(idx)}
                                onBlur={() => onEditEnd?.()}
                                style={{ flex: 1, border: 'none' }} // removed background: transparent/color inherit as input-field handles it
                            />
                            <button
                                className="icon-btn"
                                onClick={() => onPlaySegment && onPlaySegment(seg.start, seg.end)}
                                title="播放片段"
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    borderRadius: '50%',
                                    color: isActive ? '#fff' : 'var(--text-secondary)',
                                    cursor: 'pointer',
                                    padding: '0',
                                    fontSize: '0.9em',
                                    width: '28px',
                                    height: '28px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    marginLeft: '10px',
                                    transition: 'background 0.2s',
                                    flexShrink: 0,
                                    paddingLeft: (playingVideoIndex === idx) ? '0' : '2px', // Adjust visually
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(99,102,241, 0.8)'}
                                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                            >
                                {(playingVideoIndex === idx) ? '⏸' : '▶'}
                            </button>
                        </div>
                    );
                })}
            </div>
        </div >
    );
};

export default Timeline;
