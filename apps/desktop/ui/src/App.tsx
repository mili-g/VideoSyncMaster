import { useState, useEffect, useRef } from 'react'
import './App.css'
import ModernBackground from './components/ModernBackground'
import Sidebar from './components/Sidebar'
import StepBar from './components/StepBar';
import ConfirmDialog from './components/ConfirmDialog';
import ConsoleDrawer from './components/ConsoleDrawer';
import { useVideoProject } from './hooks/useVideoProject';
import { useBatchQueue } from './hooks/useBatchQueue';
import { segmentsToSRT } from './utils/srt';
import { getAsrServiceLabel } from './utils/asrService';
import { logUiError, logUiWarn } from './utils/frontendLogger';
import AppShell from './layout/AppShell';
import { getViewMeta, type ViewId } from './layout/viewRegistry';
import AsrSettingsPage from './pages/AsrSettingsPage';
import TtsSettingsPage from './pages/TtsSettingsPage';
import TranslationSettingsPage from './pages/TranslationSettingsPage';
import MergeSettingsPage from './pages/MergeSettingsPage';
import ModelCenterPage from './pages/ModelCenterPage';
import DiagnosticsPage from './pages/DiagnosticsPage';
import LogsPage from './pages/LogsPage';
import AboutPage from './pages/AboutPage';
import BatchTasksPage from './pages/BatchTasksPage';
import HomeWorkbenchPage from './pages/HomeWorkbenchPage';
import type { FileDialogResult } from './types/backend';
import { buildOutputArtifacts } from './utils/outputArtifacts';
import { resolveSubtitleArtifactLanguages } from './utils/languageTags';
import { validateSegmentLanguageFit } from './utils/subtitleLanguageGuard';

const SIDEBAR_WIDTH = 96;
const APP_SHELL_GAP = 18;
const APP_SHELL_PADDING = 18;


function App() {
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [outputDirOverride, setOutputDirOverride] = useState(() => localStorage.getItem('outputDirOverride') || '');
  const [defaultOutputDir, setDefaultOutputDir] = useState('');

  useEffect(() => {
    localStorage.setItem('outputDirOverride', outputDirOverride);
  }, [outputDirOverride]);

  useEffect(() => {
    let active = true;

    void window.api.getPaths()
      .then((paths) => {
        if (active) {
          setDefaultOutputDir(paths.outputDir || '');
        }
      })
      .catch((error) => {
        logUiError('加载默认输出目录失败', {
          domain: 'ui.settings',
          action: 'getPaths',
          detail: error instanceof Error ? error.message : String(error)
        });
      });

    return () => {
      active = false;
    };
  }, []);

  const {
    videoPath, setVideoPath,
    originalVideoPath, setOriginalVideoPath,
    mergedVideoPath,
    segments,
    translatedSegments, setTranslatedSegments,
    videoStrategy, setVideoStrategy,
    audioMixMode, setAudioMixMode,
    status, setStatus,
    loading, setLoading,
    busyTask,
    dubbingLoading,
    generatingSegmentId,
    retranslatingSegmentId,
    progress,
    isIndeterminate,
    targetLang, setTargetLang,
    asrService, handleAsrServiceChange,
    asrModelProfiles, setAsrModelProfiles,
    asrOriLang,
    setAsrOriLang,
    asrRuntimeSettings, setAsrRuntimeSettings,
    ttsService, handleTtsServiceChange,
    ttsModelProfiles, setTtsModelProfiles,
    batchSize, setBatchSize,
    cloneBatchSize, setCloneBatchSize,
    maxNewTokens, setMaxNewTokens,
    feedback, setFeedback,
    installingDeps, setInstallingDeps,
    depsPackageName, setDepsPackageName,
    consoleEntries,
    rawLogLines,
    workflowOverview,
    clearExecutionConsole,
    handleASR,
    handleTranslate,
    handleReTranslate,
    handleRetryErrors,
    handleGenerateSingleDubbing,
    handleGenerateAllDubbing,
    handleMergeVideo,
    handleSRTUpload,
    handleTargetSRTUpload,
    handleOneClickRun,
    handleTranslateAndDub,
    handleStop,
    handleUpdateSourceSegment,
    handleUpdateSegmentTiming,
    handleUpdateTranslatedSegment,
    hasErrors
  } = useVideoProject({ outputDirOverride });
  const {
    items: batchQueueItems,
    unmatchedSubtitleAssets: batchQueueUnmatchedSubtitleAssets,
    summary: batchQueueSummary,
    isRunning: isBatchQueueRunning,
    shouldResume: shouldResumeBatchQueue,
    addAssets: addBatchQueueAssets,
    assignUnmatchedSubtitle: assignBatchQueueUnmatchedSubtitle,
    removeUnmatchedSubtitle: removeBatchQueueUnmatchedSubtitle,
    removeItem: removeBatchQueueItem,
    clearCompleted: clearCompletedBatchQueue,
    clearAll: clearAllBatchQueue,
    acknowledgeResume: acknowledgeBatchQueueResume,
    retryFailed: retryFailedBatchQueue,
    openOutput: openBatchQueueOutput,
    generateMissingSubtitles: generateBatchQueueSubtitles,
    generateTranslatedSubtitles: generateBatchQueueTranslations,
    startQueue: startBatchQueue,
    stopQueue: stopBatchQueue
  } = useBatchQueue({ outputDirOverride });

  const [playingAudioIndex, setPlayingAudioIndex] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingVideoIndex, setPlayingVideoIndex] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mergedVideoSrc, setMergedVideoSrc] = useState('');
  const [currentTime, setCurrentTime] = useState(0)
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const timeIndex = segments.findIndex((seg) => currentTime >= seg.start && currentTime < seg.end);
  const activeIndex = editingIndex !== null ? editingIndex : timeIndex;
  const [seekTime, setSeekTime] = useState<number | null>(null)
  const [playUntilTime, setPlayUntilTime] = useState<number | null>(null);

  const [leftWidth, setLeftWidth] = useState(() => parseInt(localStorage.getItem('leftWidth') || '400'));
  const [timelineWidth, setTimelineWidth] = useState(() => parseInt(localStorage.getItem('timelineWidth') || '500'));
  const timelineRef = useRef<HTMLDivElement>(null);
  const translationRef = useRef<HTMLDivElement>(null);
  const isScrollingRef = useRef<null | 'timeline' | 'translation'>(null);
  const scrollResetTimeoutRef = useRef<number | null>(null);

  const [showRepairConfirm, setShowRepairConfirm] = useState(false);
  const [repairConfirmMessage, setRepairConfirmMessage] = useState('');
  const [repairResult, setRepairResult] = useState<{ success: boolean; message: string } | null>(null);
  const [missingDeps, setMissingDeps] = useState<string[]>([]);
  const [currentView, setCurrentView] = useState<ViewId>(() => (localStorage.getItem('currentView') as ViewId) || 'home');
  const backendBusy = loading || dubbingLoading || generatingSegmentId !== null || isBatchQueueRunning;
  const consoleAttention = consoleEntries.some(entry => entry.level === 'error' || entry.level === 'warn');
  const batchResumeStartedRef = useRef(false);
  useEffect(() => {
    if (!shouldResumeBatchQueue || backendBusy || batchResumeStartedRef.current) return;
    if (!batchQueueItems.some(item => item.status === 'pending')) return;

    batchResumeStartedRef.current = true;
    acknowledgeBatchQueueResume();
    setStatus('检测到上次未完成的批量任务，正在自动继续...');
    void startBatchQueue({
      outputDirOverride,
      targetLang,
      asrService,
      ttsService,
      asrOriLang,
      videoStrategy,
      audioMixMode,
      batchSize,
      cloneBatchSize,
      maxNewTokens,
      setStatus
    });
  }, [
    acknowledgeBatchQueueResume,
    asrOriLang,
    asrService,
    audioMixMode,
    backendBusy,
    batchQueueItems,
    batchSize,
    cloneBatchSize,
    maxNewTokens,
    outputDirOverride,
    setStatus,
    shouldResumeBatchQueue,
    startBatchQueue,
    targetLang,
    ttsService,
    videoStrategy
  ]);

  useEffect(() => {
    const checkEnv = async () => {
      try {
        const result = await window.api.checkPythonEnv();

        if (result && !result.success) {
          if (result.status === 'missing_python') {
            setStatus("未检测到 Python 环境 (根目录下无 python 文件夹)，请手动下载或放置便携版 Python。");
          } else {
            logUiError('环境检查失败', {
              domain: 'ui.environment',
              action: 'checkPythonEnv',
              detail: String(result.error || '未知错误')
            });
          }
        } else if (result && result.success && result.missing) {
          setMissingDeps(result.missing);
          if (result.missing.length > 0) {
            logUiWarn('检测到缺失依赖', {
              domain: 'ui.environment',
              action: 'checkPythonEnv',
              detail: result.missing.join(', ')
            });
            setStatus('检测到运行环境缺失依赖，请前往【环境诊断】查看阻塞项并执行修复。');
          }
        }
      } catch (e: unknown) {
        logUiError('环境检查执行异常', {
          domain: 'ui.environment',
          action: 'checkPythonEnv',
          detail: e instanceof Error ? e.message : String(e)
        });
      }
    };
    checkEnv();
  }, [setStatus]);

  // Persistence for Settings
  useEffect(() => { localStorage.setItem('leftWidth', leftWidth.toString()); }, [leftWidth]);
  useEffect(() => { localStorage.setItem('timelineWidth', timelineWidth.toString()); }, [timelineWidth]);
  useEffect(() => { localStorage.setItem('currentView', currentView); }, [currentView]);

  useEffect(() => {
    const validateLayout = () => {
      const sidebarWidth = SIDEBAR_WIDTH;
      const minTranslationWidth = 350;
      const minLeftWidth = 250;
      const minTimelineWidth = 300;
      const margins = APP_SHELL_PADDING * 2 + APP_SHELL_GAP;

      const totalAvailable = window.innerWidth - sidebarWidth - margins;
      const currentTotal = leftWidth + timelineWidth + minTranslationWidth;

      if (currentTotal > totalAvailable) {
        let availableForTwoColumns = totalAvailable - minTranslationWidth;
        if (availableForTwoColumns < minLeftWidth + minTimelineWidth) {
          availableForTwoColumns = minLeftWidth + minTimelineWidth;
        }

        let newLeft = leftWidth;
        let newTimeline = timelineWidth;

        if (newLeft + newTimeline > availableForTwoColumns) {
          const overflow = (newLeft + newTimeline) - availableForTwoColumns;
          const timelineShrinkable = newTimeline - minTimelineWidth;

          if (timelineShrinkable >= overflow) {
            newTimeline -= overflow;
          } else {
            newTimeline = minTimelineWidth;
            const remainingOverflow = overflow - timelineShrinkable;
            newLeft = Math.max(minLeftWidth, newLeft - remainingOverflow);
          }
        }

        if (newLeft !== leftWidth) setLeftWidth(newLeft);
        if (newTimeline !== timelineWidth) setTimelineWidth(newTimeline);
      }
    };

    validateLayout();
    window.addEventListener('resize', validateLayout);
    return () => window.removeEventListener('resize', validateLayout);
  }, [leftWidth, timelineWidth]);


  // Pause media when switching views
  useEffect(() => {
    if (currentView !== 'home') {
      if (videoRef.current) {
        videoRef.current.pause();
      }

      if (audioRef.current) {
        audioRef.current.pause();
      }
      setPlayingAudioIndex(null);
    }
  }, [currentView]);

  useEffect(() => {
    let active = true;

    const loadMergedVideo = async () => {
      if (!mergedVideoPath) {
        if (active) setMergedVideoSrc('');
        return;
      }

      try {
        const fileUrl = await window.api.getFileUrl(mergedVideoPath);
        if (active) {
          // Only refresh the preview URL when the merged output path changes.
          setMergedVideoSrc(`${fileUrl}?v=${Date.now()}`);
        }
      } catch (error) {
        logUiError('加载合成视频预览失败', {
          domain: 'ui.preview',
          action: 'loadMergedVideo',
          detail: error instanceof Error ? error.message : String(error)
        });
        if (active) setMergedVideoSrc('');
      }
    };

    loadMergedVideo();

    return () => {
      active = false;
    };
  }, [mergedVideoPath]);





  useEffect(() => {
    document.body.classList.remove('light-mode');
    document.body.classList.add('dark-bg');
    document.body.style.backgroundColor = '';
    localStorage.setItem('bgMode', 'dark');
  }, []);

  // Drag state refs to avoid closure staleness and re-renders
  const dragState = useRef<{
    startX: number;
    startLeftWidth: number;
    startTimelineWidth: number;
    target: 'left' | 'middle' | null;
  }>({ startX: 0, startLeftWidth: 0, startTimelineWidth: 0, target: null });

  // Drag handlers using Refs to avoid closure staleness
  const handleDragMove = useRef((e: MouseEvent) => {
    if (!dragState.current.target) return;

    const { startX, startLeftWidth, startTimelineWidth, target } = dragState.current;
    const deltaX = e.clientX - startX;

    const minTranslationWidth = 350;
    const minTimelineWidth = 300;
    const minLeftWidth = 250;

    const sidebarWidth = SIDEBAR_WIDTH;
    const availableContentWidth = window.innerWidth - sidebarWidth - (APP_SHELL_PADDING * 2) - APP_SHELL_GAP;

    if (target === 'left') {
      const maxLeft = availableContentWidth - timelineWidth - minTranslationWidth - 40;
      const newW = Math.max(minLeftWidth, Math.min(maxLeft, startLeftWidth + deltaX));
      setLeftWidth(newW);
    } else if (target === 'middle') {
      const maxTimeline = availableContentWidth - leftWidth - minTranslationWidth - 40;
      const newW = Math.max(minTimelineWidth, Math.min(maxTimeline, startTimelineWidth + deltaX));
      setTimelineWidth(newW);
    }
  }).current;

  const handleDragUp = useRef(() => {
    dragState.current.target = null;
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'auto';
    window.removeEventListener('mousemove', handleDragMove);
    window.removeEventListener('mouseup', handleDragUp);
  }).current;

  const startDrag = (e: React.MouseEvent, target: 'left' | 'middle') => {
    e.preventDefault();
    dragState.current = {
      startX: e.clientX,
      startLeftWidth: leftWidth,
      startTimelineWidth: timelineWidth,
      target: target
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleDragMove);
    window.addEventListener('mouseup', handleDragUp);
  };


  // Sync Scroll Handler
  const handleScroll = (source: 'timeline' | 'translation') => {
    const sourceEl = source === 'timeline' ? timelineRef.current : translationRef.current;
    const targetEl = source === 'timeline' ? translationRef.current : timelineRef.current;

    if (!sourceEl || !targetEl) return;
    if (isScrollingRef.current && isScrollingRef.current !== source) return;

    isScrollingRef.current = source;

    // Calculate percentage or exact position? exact is better if height matches.
    // But content height might differ due to text length. Percentage is safer for now.
    // Or just map index to index? No, simple scroll sync for now.
    const percentage = sourceEl.scrollTop / (sourceEl.scrollHeight - sourceEl.clientHeight);
    targetEl.scrollTop = percentage * (targetEl.scrollHeight - targetEl.clientHeight);

    // Debounce reset
    if (scrollResetTimeoutRef.current !== null) {
      window.clearTimeout(scrollResetTimeoutRef.current);
    }
    scrollResetTimeoutRef.current = window.setTimeout(() => {
      isScrollingRef.current = null;
    }, 50);
  };








  const handlePlaySegmentAudio = async (index: number, audioPath: string) => {
    const audioEl = audioRef.current;
    if (!audioEl) return;

    if (playingAudioIndex === index) {
      audioEl.pause();
      setPlayingAudioIndex(null);
      return;
    }

    try {
      const url = await window.api.getFileUrl(audioPath);
      audioEl.src = `${url}?t=${Date.now()}`;
      audioEl.play().catch(e => {
        logUiError('音频片段播放失败', {
          domain: 'ui.audio',
          action: 'playSegmentAudio',
          detail: e instanceof Error ? e.message : String(e)
        });
        setPlayingAudioIndex(null);
        setStatus("播放失败: " + (e.message || "未知错误"));
      });

      setPlayingAudioIndex(index);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logUiError('获取音频地址失败', {
        domain: 'ui.audio',
        action: 'playSegmentAudio',
        detail: err instanceof Error ? err.message : String(err)
      });
      setStatus("加载音频失败: " + message);
    }
  };

  // Modified to support pause toggle
  const handlePlaySegment = (startTime: number, endTime?: number, index?: number) => {
    // If we have an index and it matches currently playing video segment, toggle pause
    if (index !== undefined && playingVideoIndex === index) {
      if (videoRef.current) {
        if (videoRef.current.paused) {
          videoRef.current.play().catch((e) => logUiWarn('继续播放视频失败', {
            domain: 'ui.video',
            action: 'resumePlayback',
            detail: e instanceof Error ? e.message : String(e)
          }));
        } else {
          videoRef.current.pause();
          setPlayingVideoIndex(null);
        }
      }
      return;
    }

    // Switch to new segment
    if (index !== undefined) {
      setPlayingVideoIndex(index);
    } else {
      setPlayingVideoIndex(null);
    }

    setSeekTime(null);
    setTimeout(() => {
      setSeekTime(startTime);
      if (endTime) {
        // Subtle offset to prevent jumping to next segment at end
        setPlayUntilTime(endTime - 0.05);
      } else {
        setPlayUntilTime(null);
      }
    }, 10);
  };





  const handleOpenLog = () => {
    setCurrentView('logs');
    setStatus('已切换到运行日志页面。');
  };

  const ensureSingleSubtitleLanguage = (
    subtitleSegments: typeof segments,
    expectedLanguage: string,
    mode: 'source' | 'target',
    title: string
  ) => {
    const validation = validateSegmentLanguageFit(subtitleSegments, expectedLanguage, mode);
    if (!validation.ok) {
      setStatus(validation.reason || '字幕语言与当前配置不匹配。');
      setFeedback({
        title,
        message: validation.reason || '字幕语言与当前配置不匹配。',
        type: 'error'
      });
      return false;
    }
    return true;
  };

  const handleExportSRT = async () => {
    if (segments.length === 0) return;
    if (!ensureSingleSubtitleLanguage(segments, asrOriLang, 'source', '原字幕语言不匹配')) return;
    try {
      const srtContent = segmentsToSRT(segments);
      const baseName = (originalVideoPath.split(/[\\/]/).pop() || 'subtitle').replace(/\.[^/.]+$/, '');
      const artifactPaths = buildOutputArtifacts(
        outputDirOverride || '',
        `${baseName}.mp4`,
        resolveSubtitleArtifactLanguages(asrOriLang, targetLang)
      );
      const result = await window.api.showSaveDialog({
        title: '导出原始字幕',
        defaultPath: outputDirOverride ? artifactPaths.originalSubtitlePath : artifactPaths.originalSubtitlePath.split(/[\\/]/).pop() || `${baseName}.und.srt`,
        filters: [{ name: 'Subtitle Files', extensions: ['srt'] }]
      }) as FileDialogResult;

      if (!result.canceled && result.filePath) {
        await window.api.saveFile(result.filePath, srtContent);
        setStatus(`字幕已成功导出至: ${result.filePath}`);
      }
    } catch (e) {
      logUiError('导出原始字幕失败', {
        domain: 'ui.export',
        action: 'exportSourceSubtitle',
        detail: String(e)
      });
      setStatus('导出失败: ' + String(e));
    }
  };

  const handleExportTranslatedSRT = async () => {
    if (translatedSegments.length === 0) return;
    if (!ensureSingleSubtitleLanguage(translatedSegments, targetLang, 'target', '翻译字幕语言不匹配')) return;
    try {
      const srtContent = segmentsToSRT(translatedSegments);
      const baseName = (originalVideoPath.split(/[\\/]/).pop() || 'subtitle').replace(/\.[^/.]+$/, '');
      const artifactPaths = buildOutputArtifacts(
        outputDirOverride || '',
        `${baseName}.mp4`,
        resolveSubtitleArtifactLanguages(asrOriLang, targetLang)
      );
      const result = await window.api.showSaveDialog({
        title: '导出翻译字幕',
        defaultPath: outputDirOverride ? artifactPaths.translatedSubtitlePath : artifactPaths.translatedSubtitlePath.split(/[\\/]/).pop() || `${baseName}.und.srt`,
        filters: [{ name: 'Subtitle Files', extensions: ['srt'] }]
      }) as FileDialogResult;

      if (!result.canceled && result.filePath) {
        await window.api.saveFile(result.filePath, srtContent);
        setStatus(`翻译字幕已成功导出至: ${result.filePath}`);
      }
    } catch (e) {
      logUiError('导出翻译字幕失败', {
        domain: 'ui.export',
        action: 'exportTranslatedSubtitle',
        detail: String(e)
      });
      setStatus('导出失败: ' + String(e));
    }
  };

  const handleChooseOutputDir = async () => {
    try {
      const result = await window.api.openFileDialog({
        title: '选择输出目录',
        properties: ['openDirectory', 'createDirectory']
      }) as FileDialogResult;

      if (!result.canceled && Array.isArray(result.filePaths) && result.filePaths[0]) {
        setOutputDirOverride(result.filePaths[0]);
        setStatus(`输出目录已更新为: ${result.filePaths[0]}`);
      }
    } catch (e: unknown) {
      logUiError('选择输出目录失败', {
        domain: 'ui.settings',
        action: 'chooseOutputDir',
        detail: e instanceof Error ? e.message : String(e)
      });
      setStatus(`选择输出目录失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleResetOutputDir = () => {
    setOutputDirOverride('');
    setStatus(`输出目录已恢复为默认用户目录${defaultOutputDir ? `: ${defaultOutputDir}` : ''}`);
  };

  const handleRepairEnv = async () => {
    if (loading) return; // Prevent if already busy

    let message = "这将尝试自动安装/修复 Python 依赖。过程可能需要几分钟，且需联网。\n是否继续？";
    if (missingDeps.length > 0) {
      message = `检测到以下缺失的依赖项:\n\n${missingDeps.join(', ')}\n\n点击“确定”将尝试自动安装这些依赖。\n过程可能需要几分钟，且需联网。是否继续？`;
    }

    setRepairConfirmMessage(message);
    setShowRepairConfirm(true);
  };

  const confirmRepairAction = async () => {
    setShowRepairConfirm(false);

    // Continue with original logic
    setLoading(true);
    setInstallingDeps(true);
    setDepsPackageName('正在修复运行环境 (pip install)...');
    // setIsIndeterminate(true); // Redundant with overlay

    try {
      const result = await window.api.fixPythonEnv();
      if (result && result.success) {
        setStatus("环境修复完成！请重启软件以生效。");
        setRepairResult({ success: true, message: "修复完成！建议重启软件。" });
        setMissingDeps([]); // Clear flag
      } else {
        setStatus(`修复失败: ${result.error}`);
        setRepairResult({ success: false, message: `修复失败: ${result.error}\n请检查日志或网络。` });
      }
    } catch (e: unknown) {
      setStatus(`修复请求异常: ${e instanceof Error ? e.message : String(e)}`);
      logUiError('修复运行环境请求异常', {
        domain: 'ui.environment',
        action: 'fixPythonEnv',
        detail: e instanceof Error ? e.message : String(e)
      });
    } finally {
      setLoading(false);
      setInstallingDeps(false);
      setDepsPackageName('');
      // setIsIndeterminate(false);
    }
  };




  const qwenModeLabelMap: Record<string, string> = {
    clone: '克隆',
    preset: '预置',
    design: '设计'
  };
  const qwenModeLabel = qwenModeLabelMap[localStorage.getItem('qwen_mode') || 'clone'] || '克隆';
  const currentViewMeta = getViewMeta(currentView);
  const isWorkbenchView = currentView === 'home';
  const currentViewContent = currentView === 'home' ? (
    <HomeWorkbenchPage
      leftWidth={leftWidth}
      timelineWidth={timelineWidth}
      mergedVideoPath={mergedVideoPath}
      mergedVideoSrc={mergedVideoSrc}
      videoPath={videoPath}
      originalVideoPath={originalVideoPath}
      backendBusy={backendBusy}
      dubbingLoading={dubbingLoading}
      segments={segments}
      translatedSegments={translatedSegments}
      currentTime={currentTime}
      seekTime={seekTime}
      playUntilTime={playUntilTime}
      playingVideoIndex={playingVideoIndex}
      playingAudioIndex={playingAudioIndex}
      activeIndex={activeIndex}
      generatingSegmentId={generatingSegmentId}
      retranslatingSegmentId={retranslatingSegmentId}
      loading={loading}
      hasErrors={hasErrors}
      videoRef={videoRef}
      timelineRef={timelineRef}
      translationRef={translationRef}
      targetLang={targetLang}
      ttsService={ttsService}
      onVideoSelected={(path) => {
        setVideoPath(path);
        setOriginalVideoPath(path);
      }}
      onTimeUpdate={setCurrentTime}
      onVideoPause={() => setPlayingVideoIndex(null)}
      onUserSeek={() => setPlayUntilTime(null)}
      onMergeVideo={handleMergeVideo}
      onOpenMergedVideo={() => window.api.openExternal(mergedVideoPath)}
      onOpenMergedFolder={() => window.api.openFolder(mergedVideoPath)}
      onStartDrag={startDrag}
      onUpdateSegment={handleUpdateSourceSegment}
      onUpdateSegmentTiming={handleUpdateSegmentTiming}
      onPlaySegment={(start, end) => handlePlaySegment(start, end, segments.findIndex(s => s.start === start))}
      onTimelineScroll={() => handleScroll('timeline')}
      onASR={handleASR}
      asrBusy={busyTask === 'asr'}
      onEditStart={setEditingIndex}
      onEditEnd={() => setEditingIndex(null)}
      onUploadSubtitle={handleSRTUpload}
      onExportSourceSrt={handleExportSRT}
      onSetTranslatedSegments={setTranslatedSegments}
      onUpdateTranslatedSegment={handleUpdateTranslatedSegment}
      onSetTargetLang={setTargetLang}
      onTranslate={handleTranslate}
      onTranslateAndDub={handleTranslateAndDub}
      translationBusy={busyTask === 'translation'}
      onGenerateAllDubbing={handleGenerateAllDubbing}
      onGenerateSingleDubbing={handleGenerateSingleDubbing}
      onPlaySegmentAudio={handlePlaySegmentAudio}
      onTranslationScroll={() => handleScroll('translation')}
      onUploadTargetSubtitle={handleTargetSRTUpload}
      onReTranslate={handleReTranslate}
      onRetryErrors={handleRetryErrors}
      onExportTranslatedSrt={handleExportTranslatedSRT}
    />
  ) : currentView === 'batch' ? (
    <BatchTasksPage
      items={batchQueueItems}
      unmatchedSubtitleAssets={batchQueueUnmatchedSubtitleAssets}
      summary={batchQueueSummary}
      isRunning={isBatchQueueRunning}
      targetLang={targetLang}
      onSetTargetLang={setTargetLang}
      asrOriLang={asrOriLang}
      onSetAsrOriLang={setAsrOriLang}
      canGenerateSubtitles={!loading && !dubbingLoading && generatingSegmentId === null && !isBatchQueueRunning && batchQueueItems.some(item => item.status !== 'success')}
      canGenerateTranslations={!loading && !dubbingLoading && generatingSegmentId === null && !isBatchQueueRunning && batchQueueItems.some(item => item.status !== 'success' && item.originalSubtitleContent)}
      onAddAssets={addBatchQueueAssets}
      onAssignUnmatchedSubtitle={assignBatchQueueUnmatchedSubtitle}
      onRemoveUnmatchedSubtitle={removeBatchQueueUnmatchedSubtitle}
      onRemoveItem={removeBatchQueueItem}
      onClearCompleted={clearCompletedBatchQueue}
      onClearAll={clearAllBatchQueue}
      onGenerateSubtitles={() => generateBatchQueueSubtitles({
        outputDirOverride,
        targetLang,
        asrService,
        asrOriLang,
        setStatus
      })}
      onGenerateTranslations={() => generateBatchQueueTranslations({
        outputDirOverride,
        targetLang,
        asrOriLang,
        setStatus
      })}
      onRetryFailed={retryFailedBatchQueue}
      onOpenOutput={openBatchQueueOutput}
      onStart={() => startBatchQueue({
        outputDirOverride,
        targetLang,
        asrService,
        ttsService,
        asrOriLang,
        videoStrategy,
        audioMixMode,
        batchSize,
        cloneBatchSize,
        maxNewTokens,
        setStatus
      })}
      canStart={!loading && !dubbingLoading && generatingSegmentId === null && !isBatchQueueRunning && batchQueueItems.length > 0}
      onStop={() => stopBatchQueue(setStatus)}
    />
  ) : currentView === 'asr' ? (
    <AsrSettingsPage
      asrService={asrService}
      onServiceChange={handleAsrServiceChange}
      asrOriLang={asrOriLang}
      setAsrOriLang={setAsrOriLang}
      asrModelProfiles={asrModelProfiles}
      setAsrModelProfiles={setAsrModelProfiles}
      asrRuntimeSettings={asrRuntimeSettings}
      setAsrRuntimeSettings={setAsrRuntimeSettings}
    />
  ) : currentView === 'tts' ? (
    <TtsSettingsPage
      activeService={ttsService}
      onServiceChange={handleTtsServiceChange}
      ttsModelProfiles={ttsModelProfiles}
      setTtsModelProfiles={setTtsModelProfiles}
      batchSize={batchSize}
      setBatchSize={setBatchSize}
      cloneBatchSize={cloneBatchSize}
      setCloneBatchSize={setCloneBatchSize}
      maxNewTokens={maxNewTokens}
      setMaxNewTokens={setMaxNewTokens}
    />
  ) : currentView === 'translation' ? (
    <TranslationSettingsPage />
  ) : currentView === 'merge' ? (
    <MergeSettingsPage
      videoStrategy={videoStrategy}
      audioMixMode={audioMixMode}
      setVideoStrategy={setVideoStrategy}
      setAudioMixMode={setAudioMixMode}
    />
  ) : currentView === 'models' ? (
    <ModelCenterPage
      onStatusChange={setStatus}
      onFeedback={setFeedback}
    />
  ) : currentView === 'diagnostics' ? (
    <DiagnosticsPage
      selectedAsrService={asrService}
      selectedTtsService={ttsService}
      missingDeps={missingDeps}
      onStatusChange={setStatus}
      onRepairEnv={handleRepairEnv}
      onOpenModels={() => setCurrentView('models')}
    />
  ) : currentView === 'logs' ? (
    <LogsPage
      active={currentView === 'logs'}
      onStatusChange={setStatus}
    />
  ) : (
    <AboutPage />
  );

  return (
    <AppShell
      pageTitle={currentViewMeta.title}
      sidebar={
        <Sidebar
          activeService={currentView}
          onServiceChange={(s) => setCurrentView(s as ViewId)}
          onOpenModels={() => setCurrentView('models')}
          hasMissingDeps={missingDeps.length > 0}
          themeMode={'dark'}
        />
      }
      topbar={isWorkbenchView ? (
        <header className="workspace-topbar">
          <div className="workspace-command-strip">
            <div className="workspace-command-strip__lead">
              <span className="workspace-topbar__eyebrow">{currentViewMeta.title}</span>
              <strong className="workspace-command-strip__headline" title={workflowOverview.headline}>
                {workflowOverview.headline}
              </strong>
            </div>

            <div className="workspace-command-strip__flow">
              <StepBar
                steps={workflowOverview.steps}
                activeStepKey={workflowOverview.activeStepKey}
                themeMode={'dark'}
                compact
                minimal
              />
            </div>

            <div className="workspace-command-strip__engines">
              <div className="status-chip status-chip--compact">
                <span className="status-chip__label">ASR</span>
                <strong>{getAsrServiceLabel(asrService)}</strong>
              </div>
              <div className="status-chip status-chip--compact">
                <span className="status-chip__label">TTS</span>
                <strong>{ttsService === 'qwen' ? 'Qwen3' : 'Index-TTS'}</strong>
              </div>
              {ttsService === 'qwen' && (
                <div className="status-chip status-chip--accent status-chip--compact">
                  <span className="status-chip__label">模式</span>
                  <strong>{qwenModeLabel}</strong>
                </div>
              )}
            </div>

            <div className="workspace-command-strip__action">
              <div className="workspace-action-group workspace-action-group--compact">
                <button
                  onClick={handleOneClickRun}
                  disabled={backendBusy || !originalVideoPath}
                  title={!originalVideoPath ? "请先选择视频" : "自动执行所有步骤"}
                  className="primary-button"
                >
                  一键运行
                </button>
              </div>
            </div>
          </div>

          <div className="workspace-utility-row">
            <div className="workflow-summary-row">
              <span>原字幕 {workflowOverview.sourceCount}</span>
              <span>翻译 {workflowOverview.translatedCount}</span>
              <span>可用音频 {workflowOverview.dubbedReadyCount}</span>
              {workflowOverview.dubbedErrorCount > 0 && <span className="workflow-summary-row__danger">失败 {workflowOverview.dubbedErrorCount}</span>}
              {workflowOverview.latestIssue && <span className="workflow-summary-row__danger" title={workflowOverview.latestIssue.title}>异常: {workflowOverview.latestIssue.title}</span>}
            </div>

            <div className="output-dir-toolbar output-dir-toolbar--compact">
              <div className="output-dir-toolbar__path" title={outputDirOverride || defaultOutputDir || '默认目录（用户目录）'}>
                <span className="output-dir-toolbar__label">输出目录</span>
                <span className="output-dir-toolbar__value">{outputDirOverride || defaultOutputDir || '默认目录（用户目录）'}</span>
              </div>
              <div className="output-dir-toolbar__actions">
                <button
                  onClick={handleChooseOutputDir}
                  disabled={backendBusy}
                  className="secondary-button secondary-button--primary"
                >
                  选择目录
                </button>
                <button
                  onClick={handleResetOutputDir}
                  disabled={backendBusy || !outputDirOverride}
                  className="secondary-button"
                >
                  恢复默认
                </button>
              </div>
            </div>
          </div>
        </header>
      ) : undefined}
      content={
        <>
          <ConfirmDialog
            isOpen={showRepairConfirm}
            title="修复运行环境"
            message={repairConfirmMessage}
            onConfirm={confirmRepairAction}
            onCancel={() => setShowRepairConfirm(false)}
            isLightMode={false}
            confirmText="确定修复"
            cancelText="取消"
            confirmColor="#22c55e"
          />

          <ConfirmDialog
            isOpen={!!repairResult}
            title="系统提示"
            message={repairResult?.message || ""}
            onConfirm={() => setRepairResult(null)}
            isLightMode={false}
            confirmText="确定"
            cancelText=""
            onCancel={undefined}
            confirmColor={repairResult?.success ? "#22c55e" : "#ef4444"}
          />

          <ConfirmDialog
            isOpen={!!feedback}
            title={feedback?.title || ''}
            message={feedback?.message || ''}
            onConfirm={() => {
              if (feedback?.type === 'error' && feedback?.message) {
                const message = feedback.message;
                const navigateToTts = (
                  message.includes('预览') ||
                  message.includes('Preview') ||
                  message.includes('设计') ||
                  message.includes('语言') ||
                  message.includes('Language')
                );
                const navigateToModels = (
                  message.includes('模型未安装') ||
                  message.includes('模型目录') ||
                  message.includes('下载对应 ASR 模型') ||
                  message.includes('运行时依赖不完整') ||
                  message.includes('环境不兼容')
                );
                const navigateToDiagnostics = (
                  message.includes('环境诊断') ||
                  message.includes('当前 ASR 通道不可执行') ||
                  message.includes('不会自动切换')
                );
                const navigateToAsr = (
                  message.includes('ASR') ||
                  message.includes('识别失败') ||
                  message.includes('识别错误') ||
                  message.includes('faster-whisper') ||
                  message.includes('Qwen3-ASR') ||
                  message.includes('VibeVoice-ASR')
                );

                if (navigateToDiagnostics) {
                  setCurrentView('diagnostics');
                } else if (navigateToModels) {
                  setCurrentView('models');
                } else if (navigateToAsr) {
                  setCurrentView('asr');
                } else if (navigateToTts) {
                  setCurrentView('tts');
                }
              }
              setFeedback(null);
            }}
            isLightMode={false}
            confirmText={feedback?.type === 'error' ? "前往设置" : "确定"}
            confirmColor={feedback?.type === 'success' ? '#10b981' : '#3b82f6'}
            onCancel={() => setFeedback(null)}
            cancelText="取消"
          />

          <ModernBackground mode="dark" />

          <style>{`
            @keyframes indeterminate-progress {
              0% { background-position: 0% 50%; }
              100% { background-position: 100% 50%; }
            }
          `}</style>

          <audio
            ref={audioRef}
            style={{ display: 'none' }}
            onEnded={() => setPlayingAudioIndex(null)}
            onError={(e) => {
              logUiError('音频播放器发生错误', {
                domain: 'ui.audio',
                action: 'audioElementError',
                detail: String(e.type)
              });
              setPlayingAudioIndex(null);
              setStatus("播放失败: 无法加载音频文件");
            }}
          />

          {currentViewContent}
        </>
      }
      drawer={
        <ConsoleDrawer
          open={consoleOpen}
          hasAttention={consoleAttention}
          status={status}
          progress={progress}
          isIndeterminate={isIndeterminate}
          isBusy={backendBusy}
          installingDeps={installingDeps}
          depsPackageName={depsPackageName}
          entries={consoleEntries}
          rawLogLines={rawLogLines}
          onToggle={() => setConsoleOpen(prev => !prev)}
          onStop={handleStop}
          onClearStatus={() => setStatus('')}
          onClearConsole={clearExecutionConsole}
          onOpenLog={handleOpenLog}
        />
      }
      overlay={
        installingDeps ? (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 10000, backdropFilter: 'blur(20px)' }}>
            <div style={{ background: 'rgba(255,255,255,0.05)', padding: '40px', borderRadius: '24px', border: '1px solid rgba(255,255,255,0.1)', textAlign: 'center' }}>
              <div className="spinner" style={{ width: '50px', height: '50px', border: '4px solid rgba(255,255,255,0.1)', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 20px' }}></div>
              <h2 style={{ color: '#fff' }}>正在同步 AI 运行环境</h2>
              <p style={{ color: '#aaa' }}>安装核心组件: {depsPackageName || '...'}</p>
            </div>
          </div>
        ) : undefined
      }
    />
  )
}


export default App
