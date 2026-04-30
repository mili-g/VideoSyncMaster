import React, { useRef, useEffect } from 'react';
import { buildTranscodeVideoCommand } from '../utils/backendCommandBuilders';
import { runBackendCommand } from '../utils/backendCommandClient';
import { logUiBusiness, logUiDebug, logUiError, logUiWarn } from '../utils/frontendLogger';
import type { AnalyzeVideoMetadataResponse } from '../types/backend';

interface VideoUploadProps {
    onFileSelected: (path: string) => void;
    onTimeUpdate?: (time: number) => void;
    currentPath?: string;
    seekTime?: number | null;
    playUntilTime?: number | null;
    videoRef?: React.RefObject<HTMLVideoElement>;
    onVideoPause?: () => void;
    disabled?: boolean;
    onUserSeek?: () => void;
}

interface ElectronFile extends File {
    path: string;
}

const VideoUpload: React.FC<VideoUploadProps> = ({ onFileSelected, onTimeUpdate, currentPath, seekTime, playUntilTime, videoRef, onVideoPause, disabled, onUserSeek }) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const internalVideoRef = useRef<HTMLVideoElement>(null);
    const activeRef = videoRef || internalVideoRef;
    const [videoSrc, setVideoSrc] = React.useState<string>('');
    const [isDragging, setIsDragging] = React.useState(false);
    const [statusText, setStatusText] = React.useState<string>('');
    const isProgrammaticSeek = useRef(false);
    const isProgrammaticPlay = useRef(false);

    useEffect(() => {
        if (seekTime !== undefined && seekTime !== null && activeRef.current) {
            isProgrammaticSeek.current = true;
            isProgrammaticPlay.current = true;
            activeRef.current.currentTime = seekTime;
            activeRef.current.play().catch((e) => logUiWarn('视频片段自动播放失败', {
                domain: 'ui.video',
                action: 'autoPlay',
                detail: e instanceof Error ? e.message : String(e)
            }));
        }
    }, [activeRef, seekTime]);

    useEffect(() => {
        let active = true;

        const loadVideo = async () => {
            if (!currentPath) {
                if (active) setVideoSrc('');
                return;
            }

            try {
                const url = await window.api.getFileUrl(currentPath);
                if (active) {
                    setVideoSrc(url);
                }
            } catch (error) {
                logUiError('加载视频预览失败', {
                    domain: 'ui.video',
                    action: 'loadVideo',
                    detail: error instanceof Error ? error.message : String(error)
                });
            }
        };

        loadVideo();
        return () => { active = false; };
    }, [currentPath]);

    const processFileProxy = async (file: ElectronFile) => {
        if (disabled) return;
        const blobUrl = URL.createObjectURL(file);
        setVideoSrc(blobUrl);

        try {
            logUiDebug('开始缓存源视频', { domain: 'ui.video', action: 'cacheVideo' });
            const cachedPath = await window.api.cacheVideo(file.path);
            logUiDebug('源视频已写入缓存', { domain: 'ui.video', action: 'cacheVideo', detail: cachedPath });
            onFileSelected(cachedPath);

            logUiDebug('开始分析视频编码', { domain: 'ui.video', action: 'analyzeCodec' });
            const analysis = await window.api.analyzeVideoMetadata(cachedPath) as AnalyzeVideoMetadataResponse;

            if (analysis && analysis.success && analysis.info) {
                const videoCodec = String(analysis.info.video_codec || '');
                logUiDebug('视频编码分析完成', { domain: 'ui.video', action: 'analyzeCodec', detail: videoCodec });

                const supportedCodecs = ['h264', 'vp8', 'vp9', 'av1'];
                const isSupported = supportedCodecs.some((c: string) => videoCodec.toLowerCase().includes(c));

                if (!isSupported) {
                    logUiWarn('当前编码不适合直接预览，准备转码', {
                        domain: 'ui.video',
                        action: 'transcodePreview',
                        detail: videoCodec
                    });
                    setStatusText("转码中，请稍候...");

                    const transcodedPath = cachedPath.replace(/\.(\w+)$/, '_transcoded.mp4');

                    const transcodeResult = await runBackendCommand(
                        buildTranscodeVideoCommand(cachedPath, transcodedPath)
                    );

                    if (transcodeResult && transcodeResult.success) {
                        setStatusText("");
                        logUiBusiness('预览转码完成', {
                            domain: 'ui.video',
                            action: 'transcodePreview'
                        });
                        const newUrl = await window.api.getFileUrl(transcodedPath);
                        setVideoSrc(newUrl);
                        onFileSelected(transcodedPath);
                    } else {
                        setStatusText("转码失败");
                        logUiError('预览转码失败', {
                            domain: 'ui.video',
                            action: 'transcodePreview',
                            detail: String(transcodeResult?.error || '未知错误')
                        });
                    }
                }
            }

        } catch (error) {
            logUiError('源视频缓存失败，回退到原路径', {
                domain: 'ui.video',
                action: 'cacheVideo',
                detail: error instanceof Error ? error.message : String(error)
            });
            onFileSelected(file.path);
        }
    };

    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        if (disabled) return;
        const file = event.target.files?.[0];
        if (file) void processFileProxy(file as ElectronFile);
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault(); e.stopPropagation();
        if (!disabled) setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault(); e.stopPropagation();
        setIsDragging(false);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault(); e.stopPropagation(); setIsDragging(false);
        if (disabled) return;
        const file = e.dataTransfer.files?.[0];
        if (file && (file.type.startsWith('video/') || file.type.startsWith('audio/'))) {
            void processFileProxy(file as ElectronFile);
        }
    };

    const handleTimeUpdate = () => {
        if (activeRef.current) {
            const now = activeRef.current.currentTime;
            let reportTime = now;

            if (playUntilTime !== undefined && playUntilTime !== null) {
                if (now >= playUntilTime) {
                    activeRef.current.pause();
                    // Clamp reported time to playUntilTime to prevent UI jumping to next segment
                    reportTime = playUntilTime;

                    // Optional: Reset currentTime to playUntilTime to visually snap back?
                    // activeRef.current.currentTime = playUntilTime; 
                    // (Maybe distracting, just clamping report is enough for UI sync)
                }
            }

            if (onTimeUpdate) {
                onTimeUpdate(reportTime);
            }
        }
    };

    return (
        <div
            style={{
                padding: '20px',
                border: isDragging ? '2px dashed #6366f1' : '1px solid var(--border-color)',
                borderRadius: '8px',
                backgroundColor: isDragging ? 'rgba(99, 102, 241, 0.1)' : 'var(--glass-bg)',
                position: 'relative',
                backdropFilter: 'blur(10px)'
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            <h3 style={{ marginTop: 0, color: 'var(--text-primary)' }}>1. 选择视频</h3>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '10px' }}>
                <input
                    type="file"
                    accept="video/*,audio/*"
                    onChange={handleFileChange}
                    ref={fileInputRef}
                    style={{ display: 'none' }}
                    disabled={disabled}
                />
                <button
                    onClick={() => {
                        if (fileInputRef.current) {
                            fileInputRef.current.value = '';
                            fileInputRef.current.click();
                        }
                    }}
                    disabled={disabled}
                    style={{
                        padding: '11px 18px',
                        background: disabled ? 'rgba(75, 85, 99, 0.9)' : 'linear-gradient(180deg, rgba(79, 70, 229, 0.94), rgba(67, 56, 202, 0.94))',
                        color: '#f8fbff',
                        border: disabled ? '1px solid rgba(107, 114, 128, 0.4)' : '1px solid rgba(99, 102, 241, 0.36)',
                        borderRadius: '10px',
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        width: '100%',
                        fontSize: '0.95em',
                        fontWeight: 700,
                        boxShadow: disabled ? 'none' : '0 10px 24px rgba(67, 56, 202, 0.2)'
                    }}
                >
                    {isDragging ? '释放文件以加载' : '选择视频 (或拖入文件)'}
                </button>
            </div>

            {currentPath && videoSrc && (
                <div style={{ marginTop: '15px' }}>
                    <div style={{ background: '#000', borderRadius: '8px', overflow: 'hidden' }}>
                        <video
                            ref={activeRef}
                            key={videoSrc} // Force re-render on source change
                            src={videoSrc}
                            controls
                            style={{ width: '100%', maxHeight: '600px', display: 'block' }}
                            onTimeUpdate={handleTimeUpdate}
                            onPause={onVideoPause}
                            onEnded={onVideoPause}
                            onPlay={() => {
                                if (isProgrammaticPlay.current) {
                                    isProgrammaticPlay.current = false;
                                } else {
                                    // User manually clicked play. Clear the playback usage limit.
                                    if (onUserSeek) onUserSeek();
                                }
                            }}
                            onSeeking={() => {
                                if (isProgrammaticSeek.current) {
                                    isProgrammaticSeek.current = false;
                                } else if (onUserSeek) {
                                    onUserSeek();
                                }
                            }}
                            onError={(e) => {
                                logUiError('视频播放失败', {
                                    domain: 'ui.video',
                                    action: 'playback',
                                    detail: String(e.type)
                                });
                            }}
                        />
                    </div>
                    {/* Path display moved below video */}
                    {currentPath && (
                        <div style={{
                            marginTop: '10px',
                            fontSize: '0.85em',
                            color: '#6b7280',
                            wordBreak: 'break-all',
                            fontFamily: 'monospace',
                            overflowWrap: 'anywhere'
                        }}>
                            文件路径: {currentPath}
                        </div>
                    )}
                </div>
            )}

            {statusText && (
                <div style={{ marginTop: '10px', color: '#6366f1' }}>
                    {statusText}
                </div>
            )}

            {currentPath && !videoSrc && !statusText && (
                <div style={{ marginTop: '15px', padding: '10px', color: 'var(--text-secondary)' }}>
                    正在加载视频...
                </div>
            )}
        </div>
    );
};

export default VideoUpload;
