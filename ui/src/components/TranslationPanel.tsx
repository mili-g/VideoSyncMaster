import React, { useEffect, useRef } from 'react';
import { Segment } from './Timeline';

export interface TranslationPanelProps {
    segments: Segment[];
    translatedSegments: Segment[];
    setTranslatedSegments: React.Dispatch<React.SetStateAction<Segment[]>>;
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
    playingAudioIndex,
    activeIndex,
    onEditStart,
    onEditEnd,
    onUploadSubtitle,
    hasVideo = false,
    ttsService = 'indextts',
    hasErrors,
    onRetryErrors,
    onExport
}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);

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

    // Sync scroll effect for active item
    // Use passed activeIndex or calculate local fallback
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
            style={{ height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
            ref={listRef}
            onScroll={onScroll}
        >
            <div style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 10, padding: '10px', borderRadius: '8px', borderBottom: '1px solid var(--border-color)', minHeight: '110px', boxSizing: 'border-box' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>3. 翻译字幕</h3>
                    <div style={{ display: 'flex', alignItems: 'center', flex: 1, marginLeft: '15px', gap: '10px' }}>
                        <input
                            type="file"
                            accept=".srt"
                            ref={fileInputRef}
                            style={{ display: 'none' }}
                            onChange={(e) => {
                                if (e.target.files && e.target.files.length > 0) {
                                    onUploadSubtitle?.(e.target.files[0]);
                                    e.target.value = ''; // Reset
                                }
                            }}
                        />
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            onDrop={handleDrop}
                            onDragOver={handleDragOver}
                            className="btn"
                            disabled={!hasVideo || loading || dubbingLoading}
                            title={!hasVideo ? "请先上传视频" : "点击上传或拖拽SRT文件至此"}
                            style={{
                                padding: '4px 12px',
                                background: (!hasVideo || loading || dubbingLoading) ? '#4b5563' : '#10b981', // Gray if disabled
                                fontSize: '0.9em',
                                height: 'auto',
                                cursor: (!hasVideo || loading || dubbingLoading) ? 'not-allowed' : 'pointer',
                                flex: 1,
                                opacity: (!hasVideo || loading || dubbingLoading) ? 0.7 : 1
                            }}
                        >
                            上传译文字幕
                        </button>
                        <button
                            onClick={onTranslateAndDub}
                            disabled={segments.length === 0 || loading || dubbingLoading}
                            className="btn"
                            style={{
                                padding: '4px 12px',
                                background: '#8b5cf6', // Violet
                                fontSize: '0.9em',
                                height: 'auto', // Will match h3 roughly or be set explicitly
                                cursor: (segments.length === 0 || loading || dubbingLoading) ? 'not-allowed' : 'pointer',
                                opacity: (segments.length === 0 || loading || dubbingLoading) ? 0.7 : 1,
                                flex: 1
                            }}
                        >
                            翻译+生成配音
                        </button>
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '5px', marginBottom: '10px' }}>
                    <select
                        style={{ width: '90px', padding: '8px', background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '4px' }}
                        value={targetLang}
                        onChange={(e) => setTargetLang(e.target.value)}
                    >
                        {ttsService === 'qwen' ? (
                            <>
                                <option value="Chinese">中文</option>
                                <option value="English">English</option>
                                <option value="Japanese">日本語</option>
                                <option value="Korean">한국어</option>
                                <option value="German">Deutsch</option>
                                <option value="French">Français</option>
                                <option value="Russian">Русский</option>
                                <option value="Portuguese">Português</option>
                                <option value="Spanish">Español</option>
                                <option value="Italian">Italiano</option>
                            </>
                        ) : (
                            <>
                                <option value="Chinese">中文</option>
                                <option value="English">English</option>
                            </>
                        )}
                    </select>

                    <button
                        onClick={async () => {
                            if (translatedSegments.length === 0) return;
                            const paths = translatedSegments.map(s => s.audioPath).filter(p => p);
                            if (paths.length === 0) return;

                            try {
                                const result = await (window as any).ipcRenderer.invoke('run-backend', [
                                    '--action', 'check_audio_files',
                                    '--input', JSON.stringify(paths)
                                ]);

                                if (result && result.success && result.durations) {
                                    setTranslatedSegments(prev => prev.map(seg => {
                                        let newSeg = { ...seg };

                                        // 1. Check verified files
                                        if (seg.audioPath && result.durations[seg.audioPath] !== undefined) {
                                            const dur = result.durations[seg.audioPath];
                                            if (dur < 0) {
                                                newSeg.audioStatus = 'error'; // File missing
                                                newSeg.audioDuration = undefined;
                                            } else {
                                                newSeg.audioDuration = dur;
                                                // Also re-validate duration -> error if too long
                                                if (dur - (seg.end - seg.start) > 5.0) {
                                                    newSeg.audioStatus = 'error';
                                                }
                                            }
                                        }
                                        // 2. Cleanup Zombie state (Ready but no path)
                                        else if (seg.audioStatus === 'ready' && !seg.audioPath) {
                                            newSeg.audioStatus = 'error';
                                        }

                                        return newSeg;
                                    }));
                                }
                            } catch (e) { console.error(e); }
                        }}
                        className="btn"
                        style={{
                            padding: '8px 12px',
                            background: 'transparent',
                            color: 'var(--text-secondary)',
                            border: '1px solid var(--border-color)',
                            cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: '5px',
                            whiteSpace: 'nowrap'
                        }}
                        title="扫描本地文件并更新状态 (Check Files)"
                    >
                        🔍 校验状态
                    </button>
                    <button
                        onClick={onTranslate}
                        disabled={segments.length === 0 || loading || dubbingLoading}
                        className="btn"
                        style={{
                            padding: '8px 12px',
                            background: (segments.length === 0 || loading || dubbingLoading) ? '#4b5563' : '#3b82f6',
                            cursor: (segments.length === 0 || loading || dubbingLoading) ? 'not-allowed' : 'pointer',
                            opacity: (segments.length === 0 || loading || dubbingLoading) ? 0.7 : 1
                        }}
                    >
                        {loading ? '处理中...' : '翻译'}
                    </button>
                    <button
                        onClick={onGenerateAll}
                        disabled={translatedSegments.length === 0 || dubbingLoading || loading || generatingSegmentId !== null}
                        className="btn"
                        style={{
                            padding: '8px 12px',
                            background: translatedSegments.length === 0 || dubbingLoading || loading || generatingSegmentId !== null ? '#4b5563' : '#10b981',
                            cursor: translatedSegments.length === 0 || dubbingLoading || loading || generatingSegmentId !== null ? 'not-allowed' : 'pointer',
                            opacity: translatedSegments.length === 0 || dubbingLoading || loading || generatingSegmentId !== null ? 0.7 : 1,
                            height: 'fit-content'
                        }}
                    >
                        {dubbingLoading ? '处理中...' : (generatingSegmentId !== null ? '单个生成中...' : '生成全部配音')}
                    </button>

                    {hasErrors && onRetryErrors && (
                        <button
                            disabled={dubbingLoading || generatingSegmentId !== null}
                            onClick={onRetryErrors}
                            title="重新生成所有失败(红叉)的片段"
                            className="btn"
                            style={{
                                padding: '6px 12px',
                                fontSize: '0.9em',
                                background: dubbingLoading || generatingSegmentId !== null ? '#4b5563' : '#ef4444',
                                cursor: dubbingLoading || generatingSegmentId !== null ? 'not-allowed' : 'pointer',
                                opacity: dubbingLoading || generatingSegmentId !== null ? 0.7 : 1,
                                whiteSpace: 'nowrap',
                                height: 'fit-content',
                                display: 'flex', alignItems: 'center', gap: '5px'
                            }}
                        >
                            🔄 重试失败片段
                        </button>
                    )}

                    {onExport && (
                        <button
                            onClick={onExport}
                            disabled={translatedSegments.length === 0}
                            className="btn"
                            title="导出翻译字幕为 SRT 文件"
                            style={{
                                padding: '8px 12px',
                                background: translatedSegments.length === 0 ? 'transparent' : '#f59e0b',
                                border: translatedSegments.length === 0 ? '1px dashed #6b7280' : 'none',
                                color: translatedSegments.length === 0 ? '#9ca3af' : 'white',
                                cursor: translatedSegments.length === 0 ? 'not-allowed' : 'pointer',
                                display: 'flex', alignItems: 'center', gap: '5px',
                                whiteSpace: 'nowrap'
                            }}
                        >
                            💾 导出译文
                        </button>
                    )}




                </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
                {/* Timeline View of Translated Segments */}
                {(translatedSegments.length > 0 ? translatedSegments : segments).map((seg, idx) => {
                    const isTranslated = translatedSegments.length > 0;
                    const isActive = idx === activeIdx;

                    // Highlighting Logic
                    const isGenerating = generatingSegmentId === idx;
                    const isRetranslating = retranslatingSegmentId === idx;
                    const isBusy = isGenerating || isRetranslating;

                    let bgColor = 'var(--bg-secondary)';
                    let borderColor = 'transparent';

                    if (isBusy) {
                        bgColor = 'rgba(245, 158, 11, 0.2)'; // Amber active
                        borderColor = '#f59e0b';
                    } else if (isActive) {
                        bgColor = 'rgba(99,102,241, 0.3)';
                        borderColor = '#6366f1';
                    }

                    return (
                        <div
                            key={idx}
                            ref={el => itemRefs.current[idx] = el}
                            // onClick={() => onPlaySegment?.(seg.start, seg.end)} // Disabled per user request (don't play original audio on click)
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
                                        onChange={(e) => {
                                            setTranslatedSegments(prev => {
                                                const newSegs = [...prev];
                                                newSegs[idx] = { ...newSegs[idx], text: e.target.value };
                                                return newSegs;
                                            });
                                        }}
                                        style={{ flex: 1, background: 'transparent', border: 'none', color: 'inherit' }}
                                    />
                                    <div style={{ display: 'flex', gap: '5px', alignItems: 'center', flexShrink: 0 }}>
                                        {/* Status Icon */}
                                        {seg.audioStatus === 'generating' && <span title="生成中">⏳</span>}
                                        {(seg.audioStatus === 'error' || (seg.audioDuration && (seg.audioDuration - (seg.end - seg.start) > 5.0))) && <span title="生成失败: 音频过长 (幻觉)">❌</span>}
                                        {seg.audioStatus === 'ready' && !(seg.audioDuration && (seg.audioDuration - (seg.end - seg.start) > 5.0)) && <span title="已生成">✅</span>}



                                        {/* Play Button */}
                                        {seg.audioPath && (
                                            <button
                                                onClick={(e) => { e.stopPropagation(); onPlayAudio?.(idx, seg.audioPath!); }}
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
                                                {/* Show different icon if playing. Note: TranslationPanel doesn't receive playing state per segment directly 
                                                  except if we used playingAudioIndex passed in props. 
                                                  Ah, we have playingAudioIndex in props! */}
                                                {(playingAudioIndex === idx) ? '⏸' : '▶'}
                                            </button>
                                        )}

                                        {/* Regenerate Button */}
                                        <button
                                            onClick={(e) => { e.stopPropagation(); onGenerateSingle?.(idx); }}
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
                                            {generatingSegmentId === idx ? '...' : '🔄'}
                                        </button>

                                        {/* Re-translate Button */}
                                        <button
                                            onClick={(e) => { e.stopPropagation(); onReTranslate?.(idx); }}
                                            disabled={loading || dubbingLoading || generatingSegmentId !== null}
                                            title="重新翻译 (Re-translate Source)"
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
                                            <span style={{ fontSize: '1.2em' }}>↻</span>
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
        </div >
    );
};

export default TranslationPanel;
