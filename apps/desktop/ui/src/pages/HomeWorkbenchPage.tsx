import type React from 'react';
import VideoUpload from '../components/VideoUpload';
import Timeline, { type Segment } from '../components/Timeline';
import TranslationPanel from '../components/TranslationPanel';

interface HomeWorkbenchPageProps {
    leftWidth: number;
    timelineWidth: number;
    mergedVideoPath: string;
    mergedVideoSrc: string;
    videoPath: string;
    originalVideoPath: string;
    backendBusy: boolean;
    dubbingLoading: boolean;
    segments: Segment[];
    translatedSegments: Segment[];
    currentTime: number;
    seekTime: number | null;
    playUntilTime: number | null;
    playingVideoIndex: number | null;
    playingAudioIndex: number | null;
    activeIndex: number;
    generatingSegmentId: number | null;
    retranslatingSegmentId: number | null;
    loading: boolean;
    asrBusy: boolean;
    translationBusy: boolean;
    hasErrors: boolean;
    videoRef: React.RefObject<HTMLVideoElement>;
    timelineRef: React.RefObject<HTMLDivElement>;
    translationRef: React.RefObject<HTMLDivElement>;
    targetLang: string;
    ttsService: 'indextts' | 'qwen';
    onVideoSelected: (path: string) => void;
    onTimeUpdate: (time: number) => void;
    onVideoPause: () => void;
    onUserSeek: () => void;
    onMergeVideo: () => void;
    onOpenMergedVideo: () => void;
    onOpenMergedFolder: () => void;
    onStartDrag: (event: React.MouseEvent, target: 'left' | 'middle') => void;
    onUpdateSegment: (index: number, text: string) => void;
    onUpdateSegmentTiming: (index: number, start: number, end: number) => void;
    onPlaySegment: (startTime: number, endTime?: number) => void;
    onTimelineScroll: () => void;
    onASR: () => void;
    onEditStart: (index: number | null) => void;
    onEditEnd: () => void;
    onUploadSubtitle: (file: File) => void;
    onExportSourceSrt: () => void;
    onSetTranslatedSegments: React.Dispatch<React.SetStateAction<Segment[]>>;
    onUpdateTranslatedSegment: (index: number, text: string) => void;
    onSetTargetLang: (lang: string) => void;
    onTranslate: () => void;
    onTranslateAndDub: () => void;
    onGenerateAllDubbing: () => void;
    onGenerateSingleDubbing: (segmentId: number) => void;
    onPlaySegmentAudio: (index: number, audioPath: string) => void;
    onTranslationScroll: () => void;
    onUploadTargetSubtitle: (file: File) => void;
    onReTranslate: (segmentId: number) => void;
    onRetryErrors: () => void;
    onExportTranslatedSrt: () => void;
}

export default function HomeWorkbenchPage({
    leftWidth,
    timelineWidth,
    mergedVideoPath,
    mergedVideoSrc,
    videoPath,
    originalVideoPath,
    backendBusy,
    dubbingLoading,
    segments,
    translatedSegments,
    currentTime,
    seekTime,
    playUntilTime,
    playingVideoIndex,
    playingAudioIndex,
    activeIndex,
    generatingSegmentId,
    retranslatingSegmentId,
    loading,
    asrBusy,
    translationBusy,
    hasErrors,
    videoRef,
    timelineRef,
    translationRef,
    targetLang,
    ttsService,
    onVideoSelected,
    onTimeUpdate,
    onVideoPause,
    onUserSeek,
    onMergeVideo,
    onOpenMergedVideo,
    onOpenMergedFolder,
    onStartDrag,
    onUpdateSegment,
    onUpdateSegmentTiming,
    onPlaySegment,
    onTimelineScroll,
    onASR,
    onEditStart,
    onEditEnd,
    onUploadSubtitle,
    onExportSourceSrt,
    onSetTranslatedSegments,
    onUpdateTranslatedSegment,
    onSetTargetLang,
    onTranslate,
    onTranslateAndDub,
    onGenerateAllDubbing,
    onGenerateSingleDubbing,
    onPlaySegmentAudio,
    onTranslationScroll,
    onUploadTargetSubtitle,
    onReTranslate,
    onRetryErrors,
    onExportTranslatedSrt
}: HomeWorkbenchPageProps) {
    return (
        <div className="workspace-page workspace-page--workbench">
            <div className="workbench-layout">
                <div className="workbench-column workbench-column--left" style={{ width: leftWidth, paddingRight: '10px' }}>
                    <VideoUpload
                        onFileSelected={onVideoSelected}
                        currentPath={videoPath}
                        onTimeUpdate={onTimeUpdate}
                        seekTime={seekTime}
                        playUntilTime={playUntilTime}
                        videoRef={videoRef}
                        onVideoPause={onVideoPause}
                        disabled={backendBusy}
                        onUserSeek={onUserSeek}
                    />

                    <div className="glass-panel delivery-panel">
                        <div className="delivery-panel__header">
                            <div>
                                <span className="delivery-panel__eyebrow">Output</span>
                                <h3>合成结果</h3>
                            </div>
                        </div>

                        {mergedVideoPath && mergedVideoSrc && (
                            <div className="delivery-panel__preview">
                                <video
                                    src={mergedVideoSrc}
                                    controls
                                    style={{ width: '100%', display: 'block' }}
                                />
                                <div
                                    className="delivery-panel__file"
                                    onClick={onOpenMergedVideo}
                                    title="点击调用系统播放器打开"
                                >
                                    {mergedVideoPath.split(/[\\/]/).pop()} <span>(点击打开)</span>
                                </div>
                            </div>
                        )}

                        {!mergedVideoPath && (
                            <div className="delivery-panel__empty">
                                合并完成后将在此显示
                            </div>
                        )}

                        <div className="delivery-panel__actions">
                            <button
                                onClick={onMergeVideo}
                                disabled={backendBusy || !videoPath || translatedSegments.length === 0}
                                className="primary-button primary-button--success"
                            >
                                {dubbingLoading ? '处理中...' : '开始合并'}
                            </button>
                            <button
                                onClick={onOpenMergedFolder}
                                disabled={!mergedVideoPath}
                                className="secondary-button"
                            >
                                打开文件夹
                            </button>
                        </div>
                    </div>
                </div>

                <div className="resizer workbench-resizer" onMouseDown={(event) => onStartDrag(event, 'left')}>
                    <div style={{ width: '2px', height: '20px', background: 'rgba(255,255,255,0.16)' }} />
                </div>

                <div className="workbench-column" style={{ width: timelineWidth }}>
                    <Timeline
                        segments={segments}
                        currentTime={currentTime}
                        onUpdateSegment={onUpdateSegment}
                        onUpdateSegmentTiming={onUpdateSegmentTiming}
                        onPlaySegment={onPlaySegment}
                        domRef={timelineRef}
                        onScroll={onTimelineScroll}
                        onASR={onASR}
                        asrBusy={asrBusy}
                        loading={loading || dubbingLoading}
                        videoPath={videoPath}
                        playingVideoIndex={playingVideoIndex}
                        activeIndex={activeIndex}
                        onEditStart={onEditStart}
                        onEditEnd={onEditEnd}
                        onUploadSubtitle={onUploadSubtitle}
                        onExport={onExportSourceSrt}
                    />
                </div>

                <div className="resizer workbench-resizer" onMouseDown={(event) => onStartDrag(event, 'middle')}>
                    <div style={{ width: '2px', height: '20px', background: 'rgba(255,255,255,0.16)' }} />
                </div>

                <div className="workbench-column" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: '300px' }}>
                    <TranslationPanel
                        segments={segments}
                        translatedSegments={translatedSegments}
                        setTranslatedSegments={onSetTranslatedSegments}
                        onUpdateTranslatedSegment={onUpdateTranslatedSegment}
                        targetLang={targetLang}
                        setTargetLang={onSetTargetLang}
                        onTranslate={onTranslate}
                        onTranslateAndDub={onTranslateAndDub}
                        translationBusy={translationBusy}
                        onGenerateAll={onGenerateAllDubbing}
                        onGenerateSingle={onGenerateSingleDubbing}
                        onPlayAudio={onPlaySegmentAudio}
                        generatingSegmentId={generatingSegmentId}
                        retranslatingSegmentId={retranslatingSegmentId}
                        domRef={translationRef}
                        onScroll={onTranslationScroll}
                        onUploadSubtitle={onUploadTargetSubtitle}
                        hasVideo={!!originalVideoPath}
                        currentTime={currentTime}
                        dubbingLoading={dubbingLoading}
                        onReTranslate={onReTranslate}
                        loading={loading}
                        playingAudioIndex={playingAudioIndex}
                        activeIndex={activeIndex}
                        onEditStart={onEditStart}
                        onEditEnd={onEditEnd}
                        ttsService={ttsService}
                        hasErrors={hasErrors}
                        onRetryErrors={onRetryErrors}
                        onExport={onExportTranslatedSrt}
                    />
                </div>
            </div>
        </div>
    );
}
