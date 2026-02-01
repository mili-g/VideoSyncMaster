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
    currentTime?: number;
    onPlaySegment?: (start: number, end: number) => void;
    domRef?: React.RefObject<HTMLDivElement>;
    onScroll?: () => void;
    onASR?: () => void;
    loading?: boolean;
    videoPath?: string;
    playingVideoIndex?: number | null;
    activeIndex?: number;
    onEditStart?: (index: number) => void;
    onEditEnd?: () => void;
    onUploadSubtitle?: (file: File) => void;
    onExport?: () => void;
}

const formatTimestamp = (seconds: number): string => {
    if (seconds < 60) {
        return `${seconds.toFixed(2)}s`;
    }
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
};

const Timeline: React.FC<TimelineProps> = ({ segments, onUpdateSegment, currentTime = 0, onPlaySegment, domRef, onScroll, onASR, loading, videoPath, playingVideoIndex, activeIndex, onEditStart, onEditEnd, onUploadSubtitle, onExport }) => {
    const internalRef = React.useRef<HTMLDivElement>(null);
    const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);

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

    return (
        <div
            className="glass-panel"
            style={{ textAlign: 'left', height: '100%', overflowY: 'auto' }}
            ref={listRef}
            onScroll={onScroll}
        >
            <div style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 10, padding: '10px', borderRadius: '8px', borderBottom: '1px solid var(--border-color)', minHeight: '110px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <h3 style={{ margin: 0, marginBottom: '8px', color: 'var(--text-primary)' }}>2. 编辑字幕</h3>
                        <div style={{ fontSize: '0.85em', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                            点击文字可直接编辑<br />
                            点击 <span style={{ color: 'var(--text-primary)' }}>▶</span> 跳转播放
                        </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                        {onASR && (
                            <button
                                className="btn"
                                onClick={onASR}
                                disabled={loading || !videoPath}
                                style={{
                                    padding: '6px 12px',
                                    fontSize: '0.9em',
                                    background: loading || !videoPath ? '#4b5563' : '#6366f1',
                                    cursor: loading || !videoPath ? 'not-allowed' : 'pointer',
                                    opacity: loading || !videoPath ? 0.7 : 1,
                                    whiteSpace: 'nowrap',
                                    height: 'fit-content',
                                    width: '100%'
                                }}
                            >
                                {loading ? '识别中...' : '识别字幕'}
                            </button>
                        )}
                        <div style={{ display: 'flex', gap: '5px', width: '100%' }}>
                            {onExport && (
                                <button
                                    disabled={segments.length === 0}
                                    onClick={onExport}
                                    className="btn"
                                    title="导出当前字幕为 SRT 文件"
                                    style={{
                                        padding: '5px 12px',
                                        fontSize: '0.9em',
                                        background: segments.length === 0 ? 'transparent' : '#f59e0b',
                                        border: segments.length === 0 ? '1px dashed #6b7280' : 'none',
                                        color: segments.length === 0 ? '#9ca3af' : 'white',
                                        cursor: segments.length === 0 ? 'not-allowed' : 'pointer',
                                        whiteSpace: 'nowrap',
                                        height: 'fit-content',
                                        flex: 1
                                    }}
                                >
                                    💾 导出字幕
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
                                                e.target.value = ''; // reset
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
                                        title="上传本地字幕文件"
                                        style={{
                                            padding: '5px 12px',
                                            fontSize: '0.9em',
                                            background: !videoPath ? 'transparent' : '#6a38ffff',
                                            border: !videoPath ? '1px dashed #6b7280' : 'none',
                                            color: !videoPath ? '#9ca3af' : 'white',
                                            cursor: !videoPath ? 'not-allowed' : 'pointer',
                                            whiteSpace: 'nowrap',
                                            height: 'fit-content',
                                            flex: 1
                                        }}
                                    >
                                        📄 上传字幕
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
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
                            <div style={{ minWidth: '120px', fontSize: '0.85em', color: isActive ? 'var(--text-primary)' : 'var(--accent-color)' }}>
                                {formatTimestamp(seg.start)} - {formatTimestamp(seg.end)}
                            </div>
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
                                title="Play Segment"
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
