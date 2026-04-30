import React, { useEffect, useMemo, useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import type { BackendResponseBase, ModelDownloadProgressEvent, ModelStatusResponse } from '../types/backend';

interface ModelStatus {
    faster_whisper_runtime: boolean;
    funasr_runtime: boolean;
    transformers5_asr_runtime: boolean;
    faster_whisper_model: boolean;
    faster_whisper_balanced_model: boolean;
    funasr_standard: boolean;
    funasr_vad: boolean;
    funasr_punc: boolean;
    vibevoice_asr_standard: boolean;
    index_tts: boolean;
    source_separation: boolean;
    qwen_tokenizer: boolean;
    qwen_17b_base: boolean;
    qwen_17b_design: boolean;
    qwen_17b_custom: boolean;
    qwen_06b_base: boolean;
    qwen_06b_custom: boolean;
    qwen_asr_06b: boolean;
    qwen_asr_17b: boolean;
    qwen_asr_aligner: boolean;
    rife: boolean;
}

interface ModelStatusDetail {
    installed?: boolean;
    state: string;
    detail: string;
    repairable?: boolean;
}

interface DownloadResponse extends BackendResponseBase {
    error?: string;
}

interface DownloadTaskState {
    active: boolean;
    progress: string;
    percent?: number;
    phase?: ModelDownloadProgressEvent['phase'];
}

type CardState = 'loading' | 'ready' | 'blocked';

interface ModelManagerProps {
    themeMode?: 'light' | 'dark' | 'gradient';
    onStatusChange?: (status: string) => void;
    onFeedback?: (feedback: { title: string; message: string; type: 'success' | 'error' }) => void;
}

type ModelGroup = 'asr' | 'tts' | 'aux';

type ModelItem = {
    key: string;
    name: string;
    desc: string;
    link: string;
    group: ModelGroup;
    usage: string;
    requiredBy?: string;
};

type DownloadSpec = {
    modelId: string;
    localDir: string;
    genericFile?: boolean;
    downloadUrl?: string;
    baseDir?: 'models' | 'project';
    outputFileName?: string;
};

const modelCatalog: ModelItem[] = [
    { key: 'faster_whisper_runtime', name: 'faster-whisper Runtime', desc: '离线识别执行环境。', link: 'resources/media_tools/faster_whisper', group: 'asr', usage: '离线识别运行时', requiredBy: 'faster-whisper 默认执行链路' },
    { key: 'funasr_runtime', name: 'FunASR Python Runtime', desc: '官方 AutoModel 所需的 Python 运行时。', link: 'runtime/python/Lib/site-packages/funasr', group: 'asr', usage: 'FunASR 运行时', requiredBy: 'FunASR' },
    { key: 'transformers5_asr_runtime', name: 'Transformers 5.x ASR Runtime', desc: 'Transformers 系 ASR 共享执行环境。', link: 'runtime/overlays/transformers5_asr', group: 'asr', usage: '共享 ASR 运行时', requiredBy: 'VibeVoice-ASR' },
    { key: 'faster_whisper_model', name: 'faster-whisper large-v3', desc: '高质量离线识别模型。', link: 'Models/faster-whisper-large-v3-ct2', group: 'asr', usage: '标准离线识别', requiredBy: 'faster-whisper / Quality' },
    { key: 'faster_whisper_balanced_model', name: 'faster-whisper turbo', desc: '均衡型离线识别模型。', link: 'Models/faster-whisper-large-v3-turbo-ct2', group: 'asr', usage: '批量处理', requiredBy: 'faster-whisper / Balanced' },
    { key: 'funasr_standard', name: 'FunASR paraformer-zh', desc: '官方中文 acoustic model。', link: 'Models/FunASR-paraformer-zh', group: 'asr', usage: '中文识别', requiredBy: 'FunASR / Standard' },
    { key: 'funasr_vad', name: 'FunASR fsmn-vad', desc: '官方 VAD 模型。', link: 'Models/FunASR-fsmn-vad', group: 'asr', usage: '语音活动检测', requiredBy: 'FunASR / Standard' },
    { key: 'funasr_punc', name: 'FunASR ct-punc', desc: '官方标点恢复模型。', link: 'Models/FunASR-ct-punc', group: 'asr', usage: '标点恢复', requiredBy: 'FunASR / Standard' },
    { key: 'qwen_asr_17b', name: 'Qwen3-ASR 1.7B', desc: '本地多语种识别标准档位。', link: 'Models/Qwen3-ASR-1.7B', group: 'asr', usage: '多语种识别', requiredBy: 'Qwen3-ASR / Standard' },
    { key: 'qwen_asr_06b', name: 'Qwen3-ASR 0.6B', desc: '轻量级多语种识别模型。', link: 'Models/Qwen3-ASR-0.6B', group: 'asr', usage: '轻量识别', requiredBy: 'Qwen3-ASR / Fast' },
    { key: 'qwen_asr_aligner', name: 'Qwen3 Forced Aligner', desc: '字幕时间轴对齐模型。', link: 'Models/Qwen3-ForcedAligner-0.6B', group: 'asr', usage: '后对齐 / 时间轴恢复' },
    { key: 'vibevoice_asr_standard', name: 'VibeVoice-ASR HF', desc: '长音频与多说话人识别模型。', link: 'Models/VibeVoice-ASR-HF', group: 'asr', usage: '长音频 / 多说话人', requiredBy: 'VibeVoice-ASR' },
    { key: 'index_tts', name: 'Index-TTS', desc: '语音克隆合成引擎。', link: 'Models/index-tts', group: 'tts', usage: '语音克隆', requiredBy: 'Index-TTS' },
    { key: 'qwen_tokenizer', name: 'Qwen3 Tokenizer', desc: 'Qwen3-TTS 共享分词器。', link: 'Models/Qwen3-TTS-Tokenizer-12Hz', group: 'tts', usage: 'TTS 基础依赖', requiredBy: 'Qwen3-TTS 全部档位' },
    { key: 'qwen_17b_base', name: 'Qwen3-TTS 1.7B Base', desc: '正式生成优先档位。', link: 'Models/Qwen3-TTS-12Hz-1.7B-Base', group: 'tts', usage: '高质量配音', requiredBy: 'Qwen3-TTS / Quality' },
    { key: 'qwen_17b_design', name: 'Qwen3-TTS 1.7B VoiceDesign', desc: '面向音色设计和描述式声音控制。', link: 'Models/Qwen3-TTS-12Hz-1.7B-VoiceDesign', group: 'tts', usage: '声音设计', requiredBy: 'Qwen3-TTS / Design' },
    { key: 'qwen_17b_custom', name: 'Qwen3-TTS 1.7B CustomVoice', desc: '预置和自定义音色能力。', link: 'Models/Qwen3-TTS-12Hz-1.7B-CustomVoice', group: 'tts', usage: '预置音色', requiredBy: 'Qwen3-TTS / Preset' },
    { key: 'qwen_06b_base', name: 'Qwen3-TTS 0.6B Base', desc: '轻量语音合成模型。', link: 'Models/Qwen3-TTS-12Hz-0.6B-Base', group: 'tts', usage: '轻量配音', requiredBy: 'Qwen3-TTS / Fast' },
    { key: 'qwen_06b_custom', name: 'Qwen3-TTS 0.6B CustomVoice', desc: '轻量预置音色模型。', link: 'Models/Qwen3-TTS-12Hz-0.6B-CustomVoice', group: 'tts', usage: '轻量预置音色', requiredBy: 'Qwen3-TTS / Preset' },
    { key: 'source_separation', name: 'HDemucs', desc: '音轨分离模型。', link: 'Models/source_separation/hdemucs_high_musdb_plus.pt', group: 'aux', usage: '音频分离', requiredBy: '背景音保留' },
    { key: 'rife', name: 'RIFE', desc: '用于补帧和视频流畅度增强。', link: 'Models/rife', group: 'aux', usage: '视频补帧', requiredBy: '补帧流程' }
];

const groupMeta: Record<ModelGroup, { title: string; description: string }> = {
    asr: { title: 'ASR 模型', description: '本地识别引擎和辅助对齐能力。' },
    tts: { title: 'TTS 模型', description: '配音引擎和共享依赖。' },
    aux: { title: '辅助能力', description: '分离、补帧等非核心模型。' }
};

const downloadSpecs: Record<string, DownloadSpec> = {
    faster_whisper_runtime: {
        modelId: 'faster-whisper Runtime',
        localDir: 'resources/media_tools/faster_whisper',
        genericFile: true,
        baseDir: 'project',
        downloadUrl: 'https://github.com/Purfview/whisper-standalone-win/releases/download/Faster-Whisper-XXL/Faster-Whisper-XXL_r245.2_windows.7z'
    },
    funasr_standard: {
        modelId: 'iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
        localDir: 'models/FunASR-paraformer-zh'
    },
    funasr_vad: {
        modelId: 'iic/speech_fsmn_vad_zh-cn-16k-common-pytorch',
        localDir: 'models/FunASR-fsmn-vad'
    },
    funasr_punc: {
        modelId: 'iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch',
        localDir: 'models/FunASR-ct-punc'
    },
    index_tts: {
        modelId: 'Tiandong/Index-TTS',
        localDir: 'models/index-tts'
    },
    source_separation: {
        modelId: 'HDemucs Background Separation',
        localDir: 'source_separation',
        genericFile: true,
        downloadUrl: 'https://download.pytorch.org/torchaudio/models/hdemucs_high_trained.pt',
        outputFileName: 'hdemucs_high_musdb_plus.pt'
    },
    faster_whisper_model: {
        modelId: 'hf://Systran/faster-whisper-large-v3',
        localDir: 'models/faster-whisper-large-v3-ct2'
    },
    faster_whisper_balanced_model: {
        modelId: 'Tiandong/faster-whisper-large-v3-turbo-ct2',
        localDir: 'models/faster-whisper-large-v3-turbo-ct2'
    },
    vibevoice_asr_standard: {
        modelId: 'hf://microsoft/VibeVoice-ASR-HF',
        localDir: 'models/VibeVoice-ASR-HF'
    },
    qwen_tokenizer: {
        modelId: 'Qwen/Qwen3-TTS-Tokenizer-12Hz',
        localDir: 'models/Qwen3-TTS-Tokenizer-12Hz'
    },
    qwen_17b_base: {
        modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
        localDir: 'models/Qwen3-TTS-12Hz-1.7B-Base'
    },
    qwen_17b_design: {
        modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
        localDir: 'models/Qwen3-TTS-12Hz-1.7B-VoiceDesign'
    },
    qwen_17b_custom: {
        modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
        localDir: 'models/Qwen3-TTS-12Hz-1.7B-CustomVoice'
    },
    qwen_06b_base: {
        modelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
        localDir: 'models/Qwen3-TTS-12Hz-0.6B-Base'
    },
    qwen_06b_custom: {
        modelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
        localDir: 'models/Qwen3-TTS-12Hz-0.6B-CustomVoice'
    },
    qwen_asr_06b: {
        modelId: 'Qwen/Qwen3-ASR-0.6B',
        localDir: 'models/Qwen3-ASR-0.6B'
    },
    qwen_asr_17b: {
        modelId: 'Qwen/Qwen3-ASR-1.7B',
        localDir: 'models/Qwen3-ASR-1.7B'
    },
    qwen_asr_aligner: {
        modelId: 'Qwen/Qwen3-ForcedAligner-0.6B',
        localDir: 'models/Qwen3-ForcedAligner-0.6B'
    },
    rife: {
        modelId: 'rife-ncnn-vulkan',
        localDir: 'rife',
        genericFile: true,
        downloadUrl: 'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip'
    }
};

function isModelInstalled(status: ModelStatus | null, key: string): boolean {
    if (!status) return false;
    return Boolean(status[key as keyof ModelStatus]);
}

function resolveInstalled(status: ModelStatus | null, statusDetails: Record<string, ModelStatusDetail>, key: string): boolean {
    const detailInstalled = statusDetails[key]?.installed;
    if (typeof detailInstalled === 'boolean') {
        return detailInstalled;
    }
    return isModelInstalled(status, key);
}

function getCardState(loading: boolean, installed: boolean): CardState {
    if (loading) {
        return 'loading';
    }
    return installed ? 'ready' : 'blocked';
}

function getCardStateLabel(detailState: string | undefined, loading: boolean, installed: boolean): string {
    if (loading) {
        return '检测中';
    }
    if (detailState === 'ready') return '已就绪';
    if (detailState === 'blocked') return '阻塞';
    if (detailState === 'staged') return '已就位';
    if (detailState === 'unsupported_platform') return '平台不支持';
    if (detailState === 'runtime_incompatible') return '环境不兼容';
    if (detailState === 'missing_runtime') return '缺少运行时';
    if (detailState === 'runtime_incomplete') return '运行时不完整';
    if (detailState === 'degraded') return '降级可用';
    if (detailState === 'repairable') return '待修复';
    if (detailState === 'incomplete' || detailState === 'invalid') return '不完整';
    return installed ? '已安装' : '未安装';
}

function getPhaseLabel(phase: ModelDownloadProgressEvent['phase'] | undefined, active: boolean): string {
    if (phase === 'completed') return '已完成';
    if (phase === 'failed') return '失败';
    if (phase === 'canceled') return '已取消';
    if (phase === 'extracting') return '解包中';
    if (phase === 'installing') return '安装中';
    if (phase === 'downloading') return '下载中';
    if (phase === 'preparing') return '准备中';
    return active ? '处理中' : '待命';
}

const ModelManager: React.FC<ModelManagerProps> = ({ onStatusChange, onFeedback }) => {
    const [status, setStatus] = useState<ModelStatus | null>(null);
    const [statusDetails, setStatusDetails] = useState<Record<string, ModelStatusDetail>>({});
    const [modelsRoot, setModelsRoot] = useState('');
    const [loading, setLoading] = useState(true);
    const [downloadTasks, setDownloadTasks] = useState<Record<string, DownloadTaskState>>({});
    const [localFeedback, setLocalFeedback] = useState<{ title: string; message: string; type: 'success' | 'error' } | null>(null);

    const notify = (feedback: { title: string; message: string; type: 'success' | 'error' }) => {
        if (onFeedback) {
            onFeedback(feedback);
            return;
        }
        setLocalFeedback(feedback);
    };

    const checkStatus = async () => {
        setLoading(true);
        try {
            const result = await window.api.checkModelStatus() as ModelStatusResponse;
            if (result.success) {
                setStatus((result.status || null) as ModelStatus | null);
                setStatusDetails(result.status_details || {});
                setModelsRoot(result.root || '');
            }
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void checkStatus();
    }, []);

    useEffect(() => {
        const offProgress = window.api.onModelDownloadProgress((payload) => {
            const event = payload as ModelDownloadProgressEvent;
            if (!event?.key) {
                return;
            }
            const percent = typeof event.percent === 'number'
                ? Math.max(0, Math.min(100, Math.round(event.percent)))
                : undefined;
            const suffix = typeof event.percent === 'number'
                ? ` ${percent}%`
                : '';
            const message = (event.message || '').trim();
            const progress = message ? `${message}${message.includes('%') ? '' : suffix}` : `下载中${suffix}`;
            setDownloadTasks((prev) => ({
                ...prev,
                [event.key]: {
                    active: event.phase !== 'completed' && event.phase !== 'failed' && event.phase !== 'canceled',
                    progress,
                    percent,
                    phase: event.phase
                }
            }));
        });
        return () => {
            offProgress();
        };
    }, []);

    const handleDownload = async (modelKey: string) => {
        if (downloadTasks[modelKey]?.active) return;
        const isTransformers5Runtime = modelKey === 'transformers5_asr_runtime';
        const isFunasrRuntime = modelKey === 'funasr_runtime';
        const spec = downloadSpecs[modelKey];
        if (!isTransformers5Runtime && !isFunasrRuntime && !spec) {
            notify({
                title: '下载配置缺失',
                message: `模型 ${modelKey} 没有绑定下载配置，当前版本不会伪造兜底下载。`,
                type: 'error'
            });
            return;
        }
        setDownloadTasks((prev) => ({
            ...prev,
            [modelKey]: {
                active: true,
                progress: '正在准备下载...',
                percent: 0,
                phase: 'preparing'
            }
        }));
        let modelId = '';

        try {
            modelId = isTransformers5Runtime
                ? 'Transformers 5.x ASR Runtime'
                : isFunasrRuntime
                    ? 'FunASR Python Runtime'
                    : spec!.modelId;

            let result: DownloadResponse;
            if (isTransformers5Runtime) {
                result = await window.api.installTransformers5AsrRuntime({
                    key: modelKey
                });
            } else if (isFunasrRuntime) {
                result = await window.api.installFunasrRuntime({
                    key: modelKey
                });
            } else if (spec!.genericFile) {
                result = await window.api.downloadFile({
                    key: modelKey,
                    url: spec!.downloadUrl || '',
                    targetDir: spec!.localDir,
                    name: modelId,
                    baseDir: spec!.baseDir || 'models',
                    outputFileName: spec!.outputFileName
                });
            } else {
                result = await window.api.downloadModel({
                    key: modelKey,
                    model: modelId,
                    localDir: spec!.localDir
                });
            }

            if (result.success) {
                onStatusChange?.(`模型下载完成：${modelId}`);
                notify({
                    title: '下载完成',
                    message: `模型 ${modelId} 已下载完成，可返回对应功能页直接使用。`,
                    type: 'success'
                });
                void checkStatus();
            } else if (result.error !== 'Cancelled') {
                onStatusChange?.(`模型下载失败：${modelId}`);
                notify({
                    title: '下载失败',
                    message: `模型 ${modelId} 下载失败：\n${result.error}`,
                    type: 'error'
                });
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(error);
            onStatusChange?.(`模型下载请求出错：${modelId}`);
            notify({
                title: '下载请求异常',
                message: `模型 ${modelId} 下载请求出错：\n${message}`,
                type: 'error'
            });
        } finally {
            setDownloadTasks((prev) => ({
                ...prev,
                [modelKey]: {
                    active: false,
                    progress: prev[modelKey]?.progress || '下载已结束',
                    percent: prev[modelKey]?.phase === 'completed'
                        ? 100
                        : prev[modelKey]?.percent,
                    phase: prev[modelKey]?.phase
                }
            }));
        }
    };

    const handleCancel = async (modelKey: string) => {
        try {
            const spec = downloadSpecs[modelKey];
            if (spec?.genericFile) {
                await window.api.cancelFileDownload({ key: modelKey });
            } else {
                await window.api.cancelDownload({ key: modelKey });
            }
            setDownloadTasks((prev) => ({
                ...prev,
                [modelKey]: {
                    active: false,
                    progress: '正在取消...',
                    percent: prev[modelKey]?.percent,
                    phase: 'canceled'
                }
            }));
        } catch (error) {
            console.error('Cancel failed', error);
        }
    };

    const groupedModels = useMemo(() => {
        return {
            asr: modelCatalog.filter((item) => item.group === 'asr'),
            tts: modelCatalog.filter((item) => item.group === 'tts'),
            aux: modelCatalog.filter((item) => item.group === 'aux')
        };
    }, []);

    const installedCount = modelCatalog.filter((item) => resolveInstalled(status, statusDetails, item.key)).length;
    const missingCount = modelCatalog.length - installedCount;
    const hasActiveDownloads = Object.values(downloadTasks).some((task) => task.active);

    const renderCard = (item: ModelItem) => {
        const isInstalled = resolveInstalled(status, statusDetails, item.key);
        const downloadTask = downloadTasks[item.key];
        const isDownloadingThis = !!downloadTask?.active;
        const progressPercent = typeof downloadTask?.percent === 'number'
            ? Math.max(0, Math.min(100, downloadTask.percent))
            : null;
        const hasDownloadFeedback = Boolean(downloadTask?.progress);
        const detail = statusDetails[item.key];
        const cardState = getCardState(loading, isInstalled);
        const statusLabel = getCardStateLabel(detail?.state, loading, isInstalled);
        const phaseLabel = getPhaseLabel(downloadTask?.phase, isDownloadingThis);
        const footerNote = isInstalled
            ? '目录和关键文件已通过当前状态检查。'
            : '当前环境未发现该模型或运行时，请先完成下载与校验。';

        return (
            <article key={item.key} className={`model-card${cardState === 'ready' ? ' model-card--ready' : cardState === 'blocked' ? ' model-card--missing' : ''}`}>
                <div className="model-card__header">
                    <div>
                        <h4>{item.name}</h4>
                        <p>{item.desc}</p>
                    </div>
                    <span className={`model-status-pill${detail?.state === 'ready' ? ' model-status-pill--ready' : ''}`}>
                        {statusLabel}
                    </span>
                </div>

                <div className="model-meta-list">
                    <div className="model-meta-item">
                        <span>用途</span>
                        <strong>{item.usage}</strong>
                    </div>
                    <div className="model-meta-item">
                        <span>关联能力</span>
                        <strong>{item.requiredBy || '通用'}</strong>
                    </div>
                    <div className="model-meta-item model-meta-item--path">
                        <span>路径</span>
                        <strong title={item.link}>{item.link}</strong>
                    </div>
                </div>

                {detail?.detail && detail.state !== 'ready' && (
                    <div className="model-meta-list" style={{ marginTop: 12 }}>
                        <div className="model-meta-item" style={{ display: 'block' }}>
                            <span>{detail.state === 'degraded' ? '状态说明' : '不可用原因'}</span>
                            <strong style={{ display: 'block', marginTop: 6, whiteSpace: 'normal', lineHeight: 1.5 }}>
                                {detail.detail}
                            </strong>
                        </div>
                    </div>
                )}

                <div className="model-card__footer">
                    {hasDownloadFeedback && (
                        <div className="download-progress-panel" aria-live="polite">
                            <div className="download-progress-panel__meta">
                                <span>{downloadTask?.progress}</span>
                                <strong>{progressPercent !== null ? `${progressPercent}%` : phaseLabel}</strong>
                            </div>
                            <div className="download-progress-bar" aria-hidden="true">
                                <span style={{ width: `${progressPercent ?? 0}%` }} />
                            </div>
                            <div className="download-progress-panel__state">{phaseLabel}</div>
                        </div>
                    )}

                    <p className="model-card__hint">{footerNote}</p>

                    {!isInstalled && (
                        <div className="model-card__actions">
                            {isDownloadingThis ? (
                                <button type="button" className="secondary-button secondary-button--danger" onClick={() => handleCancel(item.key)}>
                                    停止下载
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    className="primary-button"
                                    onClick={() => handleDownload(item.key)}
                                >
                                    {item.key === 'faster_whisper_runtime' || item.key === 'transformers5_asr_runtime' || item.key === 'funasr_runtime' ? '安装运行时' : '下载并校验'}
                                </button>
                            )}
                        </div>
                    )}
                    </div>
            </article>
        );
    };

    return (
        <div className="config-page">
            <ConfirmDialog
                isOpen={!!localFeedback}
                title={localFeedback?.title || ''}
                message={localFeedback?.message || ''}
                onConfirm={() => setLocalFeedback(null)}
                onCancel={() => setLocalFeedback(null)}
                isLightMode={false}
                confirmText="确定"
                cancelText={localFeedback?.type === 'error' ? '关闭' : ''}
                confirmColor={localFeedback?.type === 'success' ? '#10b981' : '#3b82f6'}
            />

            <div className="config-page__hero">
                <div>
                    <span className="config-page__eyebrow">Models</span>
                    <h1>模型中心</h1>
                    <p>集中管理识别、配音与辅助能力所需的模型及运行时，并展示实时可用状态。</p>
                </div>
                <div className="config-page__hero-meta">
                    <div className="status-kpi">
                        <span className="status-kpi__label">已安装</span>
                        <strong>{installedCount}</strong>
                    </div>
                    <div className="status-kpi">
                        <span className="status-kpi__label">缺失</span>
                        <strong>{missingCount}</strong>
                    </div>
                </div>
            </div>

            <div className="model-toolbar">
                <div className="model-root-card">
                    <span className="model-root-card__label">模型根目录</span>
                    <strong title={modelsRoot || '正在检测...'}>{modelsRoot || '正在检测...'}</strong>
                    <small>未内置的模型与依赖将在此目录统一管理，并供主应用按需调用。</small>
                </div>
                <button type="button" className="secondary-button" onClick={() => void checkStatus()} disabled={hasActiveDownloads}>
                    刷新状态
                </button>
            </div>

            {(['asr', 'tts', 'aux'] as ModelGroup[]).map((group) => (
                <section key={group} className="config-section">
                    <div className="config-section__head">
                        <div>
                            <h3>{groupMeta[group].title}</h3>
                            <p>{groupMeta[group].description}</p>
                        </div>
                    </div>
                    <div className="model-grid">
                        {groupedModels[group].map(renderCard)}
                    </div>
                </section>
            ))}
        </div>
    );
};

export default ModelManager;
