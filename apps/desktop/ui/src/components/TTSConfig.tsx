
import React, { useState, useEffect } from 'react';
import QwenTTSConfig from './QwenTTSConfig';
import ConfirmDialog from './ConfirmDialog';
import {
    getStoredGptSovitsTtsSettings,
    getRecommendedGptSovitsTtsSettings,
    getStoredTtsVoiceMode,
    GPT_SOVITS_BUILTIN_PROMPT_JING_YUAN,
    GPT_SOVITS_BUILTIN_PROMPT_KAFKA,
    GPT_SOVITS_BUILTIN_VOICE_JING_YUAN,
    GPT_SOVITS_BUILTIN_VOICE_KAFKA,
    type GptSovitsTtsSettings,
    type TtsVoiceMode
} from '../utils/runtimeSettings';
import { TTS_MODEL_PROFILES, setStoredTtsModelProfile, type TtsService } from '../utils/modelProfiles';
import { FieldBlock } from '../features/asr/shared';
import type { FileDialogResult } from '../types/backend';
import type { TtsRuntimeDiagnosticsPayload } from '../types/backend';

const INDEX_TTS_STORAGE_KEYS = [
    'tts_ref_audio_path',
    'tts_temperature',
    'tts_top_p',
    'tts_repetition_penalty',
    'tts_cfg_scale',
    'tts_num_beams',
    'tts_top_k',
    'tts_length_penalty',
    'tts_max_mel_tokens'
] as const;

const GPT_SOVITS_STORAGE_KEYS = [
    'gpt_sovits_ref_audio_path',
    'gpt_sovits_prompt_text',
    'gpt_sovits_text_split_method',
    'gpt_sovits_speed_factor',
    'gpt_sovits_batch_threshold',
    'gpt_sovits_parallel_infer',
    'gpt_sovits_sample_steps',
    'gpt_sovits_official_fast_mode'
] as const;

interface TTSConfigProps {
    themeMode?: 'light' | 'dark' | 'gradient';
    activeService: TtsService;
    onServiceChange: (service: TtsService) => Promise<boolean>;
    ttsModelProfiles: Record<TtsService, string>;
    setTtsModelProfiles: React.Dispatch<React.SetStateAction<Record<TtsService, string>>>;
    onQwenModeChange: (mode: 'clone' | 'design' | 'preset') => void;
    batchSize: number;
    setBatchSize: (size: number) => void;
    cloneBatchSize: number;
    setCloneBatchSize: (size: number) => void;
    maxNewTokens: number;
    setMaxNewTokens: (token: number) => void;
}

interface SliderControlProps {
    label: string;
    value: number;
    setValue: (value: number) => void;
    min: number;
    max: number;
    step: number;
    desc?: string;
}

const TTSConfig: React.FC<TTSConfigProps> = ({ themeMode, activeService, onServiceChange, ttsModelProfiles, setTtsModelProfiles, onQwenModeChange, batchSize, setBatchSize, cloneBatchSize, setCloneBatchSize, maxNewTokens, setMaxNewTokens }) => {
    const isLightMode = themeMode === 'gradient' || themeMode === 'light';
    const formatBuiltinGptSovitsRefLabel = (value: string) => {
        if (value === GPT_SOVITS_BUILTIN_VOICE_JING_YUAN) return '内置音色 / 景元（男声）';
        if (value === GPT_SOVITS_BUILTIN_VOICE_KAFKA) return '内置音色 / 卡芙卡（女声）';
        return value;
    };

    // IndexTTS States
    const [refAudioPath, setRefAudioPath] = useState<string>('');
    const [temperature, setTemperature] = useState<number>(0.7);
    const [topP, setTopP] = useState<number>(0.8);
    const [repetitionPenalty, setRepetitionPenalty] = useState<number>(1.0);

    const [cfgScale, setCfgScale] = useState<number>(0.7);

    // Advanced Params
    const [numBeams, setNumBeams] = useState<number>(1);
    const [topK, setTopK] = useState<number>(5);
    const [lengthPenalty, setLengthPenalty] = useState<number>(1.0);
    const [maxMelTokens, setMaxMelTokens] = useState<number>(2048);
    const [gptSovitsSettings, setGptSovitsSettings] = useState<GptSovitsTtsSettings>(() => getStoredGptSovitsTtsSettings());

    // Switching State
    const [switching, setSwitching] = useState(false);
    const [switchStatus, setSwitchStatus] = useState('');

    // Dialog State
    const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
    const [feedback, setFeedback] = useState<{ title: string; message: string; type: 'success' | 'error' } | null>(null);
    const [voiceMode, setVoiceMode] = useState<TtsVoiceMode>(() => getStoredTtsVoiceMode(activeService));

    // View State (Separate from Active Service)
    const [viewMode, setViewMode] = useState<TtsService>(() => {
        const stored = localStorage.getItem('last_tts_view');
        return stored === 'qwen' || stored === 'indextts' || stored === 'gptsovits'
            ? stored as TtsService
            : (activeService || 'indextts');
    });
    const [ttsDiagnostics, setTtsDiagnostics] = useState<TtsRuntimeDiagnosticsPayload | null>(null);
    const [ttsDiagnosticsError, setTtsDiagnosticsError] = useState<string>('');
    const [ttsDiagnosticsLoading, setTtsDiagnosticsLoading] = useState(false);

    // Load IndexTTS config
    useEffect(() => {
        const storedRef = localStorage.getItem('tts_ref_audio_path');
        if (storedRef) setRefAudioPath(storedRef);
        const storedTemp = localStorage.getItem('tts_temperature');
        if (storedTemp) setTemperature(parseFloat(storedTemp));
        const storedTopP = localStorage.getItem('tts_top_p');
        if (storedTopP) setTopP(parseFloat(storedTopP));
        const storedRepPen = localStorage.getItem('tts_repetition_penalty');
        if (storedRepPen) setRepetitionPenalty(parseFloat(storedRepPen));
        const storedCfg = localStorage.getItem('tts_cfg_scale');
        if (storedCfg) setCfgScale(parseFloat(storedCfg));

        const storedBeams = localStorage.getItem('tts_num_beams');
        if (storedBeams) setNumBeams(parseInt(storedBeams));
        const storedTopK = localStorage.getItem('tts_top_k');
        if (storedTopK) setTopK(parseInt(storedTopK));
        const storedLenPen = localStorage.getItem('tts_length_penalty');
        if (storedLenPen) setLengthPenalty(parseFloat(storedLenPen));
        const storedMaxMel = localStorage.getItem('tts_max_mel_tokens');
        if (storedMaxMel) setMaxMelTokens(parseInt(storedMaxMel));
    }, []);

    // Save view mode
    useEffect(() => {
        localStorage.setItem('last_tts_view', viewMode);
    }, [viewMode]);

    useEffect(() => {
        localStorage.setItem('tts_voice_mode', voiceMode);
    }, [voiceMode]);

    const handleSaveIndex = () => {
        localStorage.setItem('tts_ref_audio_path', refAudioPath);
        localStorage.setItem('tts_temperature', temperature.toString());
        localStorage.setItem('tts_top_p', topP.toString());
        localStorage.setItem('tts_repetition_penalty', repetitionPenalty.toString());
        localStorage.setItem('tts_cfg_scale', cfgScale.toString());
        localStorage.setItem('tts_num_beams', numBeams.toString());
        localStorage.setItem('tts_top_k', topK.toString());
        localStorage.setItem('tts_length_penalty', lengthPenalty.toString());
        localStorage.setItem('tts_max_mel_tokens', maxMelTokens.toString());
        setFeedback({ title: '保存成功', message: 'Index-TTS 配置已保存。', type: 'success' });
    };

    const handleSaveGptSovits = () => {
        localStorage.setItem('gpt_sovits_ref_audio_path', gptSovitsSettings.refAudio);
        localStorage.setItem('gpt_sovits_prompt_text', gptSovitsSettings.promptText);
        localStorage.setItem('gpt_sovits_text_split_method', gptSovitsSettings.textSplitMethod);
        localStorage.setItem('gpt_sovits_speed_factor', String(gptSovitsSettings.speedFactor));
        localStorage.setItem('gpt_sovits_batch_threshold', String(gptSovitsSettings.batchThreshold));
        localStorage.setItem('gpt_sovits_parallel_infer', gptSovitsSettings.parallelInfer ? 'true' : 'false');
        localStorage.setItem('gpt_sovits_sample_steps', String(gptSovitsSettings.sampleSteps));
        localStorage.setItem('gpt_sovits_official_fast_mode', gptSovitsSettings.officialFastMode ? 'true' : 'false');
        setFeedback({ title: '保存成功', message: 'GPT-SoVITS 配置已保存。', type: 'success' });
    };

    const confirmResetIndex = () => {
        setRefAudioPath('');
        setTemperature(0.7);
        setTopP(0.8);
        setRepetitionPenalty(1.0);
        setCfgScale(0.7);
        setNumBeams(1);
        setTopK(5);
        setLengthPenalty(1.0);
        setMaxMelTokens(2048);
        INDEX_TTS_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
        setFeedback({ title: '已恢复默认', message: 'Index-TTS 配置已重置为默认值。', type: 'success' });
        setIsResetDialogOpen(false);
    };

    const confirmResetGptSovits = () => {
        setGptSovitsSettings(
            getRecommendedGptSovitsTtsSettings(ttsModelProfiles.gptsovits, {
                refAudio: GPT_SOVITS_BUILTIN_VOICE_JING_YUAN,
                promptText: GPT_SOVITS_BUILTIN_PROMPT_JING_YUAN
            })
        );
        GPT_SOVITS_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
        setFeedback({ title: '已恢复默认', message: 'GPT-SoVITS 配置已重置为默认值。', type: 'success' });
        setIsResetDialogOpen(false);
    };

    const handleSelectFile = async (onSelect: (filePath: string) => void) => {
        try {
            const result = await window.api.openFileDialog({
                filters: [{ name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'm4a'] }]
            }) as FileDialogResult;
            if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                onSelect(result.filePaths[0]);
            }
        } catch (e) {
            console.error(e);
        }
    };

    const handleSwitchService = async (target: TtsService) => {
        if (target === activeService) return;

        setSwitching(true);
        setSwitchStatus('正在切换配音引擎...');

        try {
            const success = await onServiceChange(target);
            if (!success) {
                return;
            }
        } catch (e) {
            console.error(e);
            setSwitchStatus('切换失败');
            setFeedback({ title: '切换失败', message: '引擎切换失败，请查看日志。', type: 'error' });
            return;
        } finally {
            setSwitchStatus('');
            setSwitching(false);
        }
    };

    const SliderControl = ({ label, value, setValue, min, max, step, desc }: SliderControlProps) => (
        <div className="slider-row">
            <div className="slider-row__head">
                <label>{label}</label>
                <span>{value}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => setValue(parseFloat(e.target.value))}
                style={{ width: '100%', cursor: 'pointer' }}
            />
            {desc && <p className="control-hint">{desc}</p>}
        </div>
    );

    const handleTtsModelProfileChange = (service: TtsService, profileId: string) => {
        setStoredTtsModelProfile(service, profileId);
        setTtsModelProfiles(prev => ({
            ...prev,
            [service]: profileId
        }));
        if (service === 'gptsovits') {
            setGptSovitsSettings(prev => getRecommendedGptSovitsTtsSettings(profileId, prev));
        }
    };

    useEffect(() => {
        let cancelled = false;
        const representativeText = viewMode === 'qwen'
            ? '这是运行诊断示例文本。'
            : viewMode === 'gptsovits'
                ? '这是 GPT-SoVITS 运行诊断示例文本。'
                : '这是 Index-TTS 运行诊断示例文本。';
        const effectiveBatchSize = viewMode === 'qwen'
            ? (voiceMode === 'narration' ? batchSize : cloneBatchSize)
            : batchSize;

        const fetchDiagnostics = async () => {
            setTtsDiagnosticsLoading(true);
            try {
                const result = await window.api.getTtsRuntimeDiagnostics({
                    ttsService: viewMode,
                    text: representativeText,
                    duration: 3.2,
                    batchSize: effectiveBatchSize,
                    ttsModelProfile: viewMode === 'gptsovits' ? ttsModelProfiles.gptsovits : undefined,
                    maxNewTokens: viewMode === 'qwen' ? maxNewTokens : maxMelTokens,
                    gptSovitsParallelInfer: gptSovitsSettings.parallelInfer,
                    gptSovitsSampleSteps: gptSovitsSettings.sampleSteps,
                    gptSovitsBatchThreshold: gptSovitsSettings.batchThreshold,
                    gptSovitsTextSplitMethod: gptSovitsSettings.textSplitMethod,
                    gptSovitsOfficialFastMode: gptSovitsSettings.officialFastMode
                });
                if (cancelled) return;
                if (result?.success && result.diagnostics) {
                    setTtsDiagnostics(result.diagnostics);
                    setTtsDiagnosticsError('');
                } else {
                    setTtsDiagnostics(null);
                    setTtsDiagnosticsError(result?.error || '运行诊断不可用');
                }
            } catch (error) {
                if (cancelled) return;
                setTtsDiagnostics(null);
                setTtsDiagnosticsError(error instanceof Error ? error.message : String(error));
            } finally {
                if (!cancelled) setTtsDiagnosticsLoading(false);
            }
        };

        const timer = window.setTimeout(fetchDiagnostics, 220);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [
        viewMode,
        voiceMode,
        batchSize,
        cloneBatchSize,
        maxNewTokens,
        maxMelTokens,
        gptSovitsSettings.parallelInfer,
        gptSovitsSettings.sampleSteps,
        gptSovitsSettings.batchThreshold,
        gptSovitsSettings.textSplitMethod,
        gptSovitsSettings.officialFastMode,
        ttsModelProfiles.gptsovits
    ]);

    const diagnosticsSnapshot = ttsDiagnostics?.snapshot || ttsDiagnostics?.adaptive_batch_detail || null;
    const diagnosticsFreeText = diagnosticsSnapshot && typeof diagnosticsSnapshot.free_gb === 'number'
        ? `${diagnosticsSnapshot.free_gb.toFixed(2)} GB`
        : '--';
    const diagnosticsTotalText = diagnosticsSnapshot && typeof diagnosticsSnapshot.total_gb === 'number'
        ? `${diagnosticsSnapshot.total_gb.toFixed(2)} GB`
        : '--';
    const diagnosticsTier = String(ttsDiagnostics?.tier || 'unknown').toUpperCase();
    const diagnosticsSinglePairs = Object.entries(ttsDiagnostics?.effective_single || {}).slice(0, 4);
    const diagnosticsBatchPairs = Object.entries(ttsDiagnostics?.effective_batch || {});

    return (
        <div className="tool-panel" style={{ padding: '6px 2px', color: isLightMode ? '#333' : '#fff' }}>

            <ConfirmDialog
                isOpen={isResetDialogOpen}
                title="重置配置"
                message={viewMode === 'gptsovits'
                    ? '确定要重置所有 GPT-SoVITS 配置参数吗？此操作无法撤销。'
                    : '确定要重置所有 Index-TTS 配置参数吗？此操作无法撤销。'}
                onConfirm={viewMode === 'gptsovits' ? confirmResetGptSovits : confirmResetIndex}
                onCancel={() => setIsResetDialogOpen(false)}
                isLightMode={isLightMode}
                confirmColor="#ef4444"
                confirmText="确定重置"
            />

            <ConfirmDialog
                isOpen={!!feedback}
                title={feedback?.title || ''}
                message={feedback?.message || ''}
                onConfirm={() => setFeedback(null)}
                isLightMode={isLightMode}
                confirmColor={feedback?.type === 'success' ? '#10b981' : '#ef4444'}
                confirmText={feedback?.type === 'success' ? '好' : '我知道了'}
            />

            <div className="tool-toolbar">
                <div className="tool-toolbar__title">
                    <h3>{viewMode === 'qwen' ? 'Qwen3-TTS' : viewMode === 'gptsovits' ? 'GPT-SoVITS' : 'Index-TTS'}</h3>
                </div>

                <div className="segmented-control segmented-control--horizontal">
                    <button
                        onClick={() => setViewMode('indextts')}
                        className={`segmented-control__button${viewMode === 'indextts' ? ' segmented-control__button--active' : ''}`}
                    >
                        {activeService === 'indextts' && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 5px #22c55e' }}></span>} Index-TTS
                    </button>
                    <button
                        onClick={() => setViewMode('qwen')}
                        className={`segmented-control__button${viewMode === 'qwen' ? ' segmented-control__button--active' : ''}`}
                    >
                        {activeService === 'qwen' && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 5px #22c55e' }}></span>} Qwen3-TTS
                    </button>
                    <button
                        onClick={() => setViewMode('gptsovits')}
                        className={`segmented-control__button${viewMode === 'gptsovits' ? ' segmented-control__button--active' : ''}`}
                    >
                        {activeService === 'gptsovits' && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 5px #22c55e' }}></span>} GPT-SoVITS
                    </button>
                </div>
            </div>

            <div
                className="tool-banner"
                style={{
                    marginTop: '10px',
                    padding: '12px 14px',
                    borderRadius: 8,
                    border: isLightMode ? '1px solid #dbe3f0' : '1px solid #334155',
                    background: isLightMode ? '#f8fbff' : 'rgba(15,23,42,0.58)'
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div>
                        <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 4 }}>硬件自适应</div>
                        <div style={{ fontSize: 18, fontWeight: 700 }}>{diagnosticsTier}</div>
                        <div style={{ fontSize: 12, opacity: 0.78, marginTop: 2 }}>
                            可用显存 {diagnosticsFreeText} / 总显存 {diagnosticsTotalText}
                        </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(120px, 1fr))', gap: '6px 14px', flex: '1 1 320px' }}>
                        {diagnosticsSinglePairs.map(([key, value]) => (
                            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
                                <span style={{ opacity: 0.66 }}>{key}</span>
                                <span style={{ fontWeight: 600 }}>{String(value)}</span>
                            </div>
                        ))}
                        {!diagnosticsSinglePairs.length && (
                            <div style={{ fontSize: 12, opacity: 0.72 }}>
                                {ttsDiagnosticsLoading ? '正在读取运行状态…' : (ttsDiagnosticsError || '运行诊断暂不可用')}
                            </div>
                        )}
                    </div>
                </div>
                {!!diagnosticsBatchPairs.length && (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: isLightMode ? '1px solid #e5edf8' : '1px solid #243244', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        {diagnosticsBatchPairs.map(([key, value]) => (
                            <span key={key} style={{ fontSize: 12, opacity: 0.82 }}>
                                {key}: <strong>{String(value)}</strong>
                            </span>
                        ))}
                    </div>
                )}
            </div>

            {switching && (
                <div className="tool-banner tool-banner--warn" style={{ textAlign: 'center' }}>
                    <div className="spinner" style={{ display: 'inline-block', width: '20px', height: '20px', border: '3px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 1s linear infinite', marginRight: '10px' }}></div>
                    {switchStatus}
                    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                </div>
            )}

            <div className="config-section">
                <div className="tool-toolbar">
                    <div className="tool-toolbar__title">
                        <h3>运行模式</h3>
                    </div>
                    <div className="segmented-control segmented-control--horizontal">
                        <button
                            onClick={() => setVoiceMode('clone')}
                            className={`segmented-control__button${voiceMode === 'clone' ? ' segmented-control__button--active' : ''}`}
                        >
                            克隆模式
                        </button>
                        <button
                            onClick={() => setVoiceMode('narration')}
                            className={`segmented-control__button${voiceMode === 'narration' ? ' segmented-control__button--active' : ''}`}
                        >
                            朗读模式
                        </button>
                    </div>
                </div>

                {viewMode === 'qwen' ? (
                    <QwenTTSConfig
                        themeMode={themeMode}
                        voiceMode={voiceMode}
                        isActive={activeService === 'qwen'}
                        modelProfile={ttsModelProfiles.qwen}
                        onModelProfileChange={(profileId) => handleTtsModelProfileChange('qwen', profileId)}
                        onActivate={() => handleSwitchService('qwen')}
                        onModeChange={onQwenModeChange}
                        batchSize={batchSize}
                        setBatchSize={setBatchSize}
                        cloneBatchSize={cloneBatchSize}
                        setCloneBatchSize={setCloneBatchSize}
                        maxNewTokens={maxNewTokens}
                        setMaxNewTokens={setMaxNewTokens}
                    />
                ) : viewMode === 'gptsovits' ? (
                    <>
                        <div className="dense-grid dense-grid--single">
                            <FieldBlock label="模型档位" hint={TTS_MODEL_PROFILES.gptsovits.find(option => option.id === ttsModelProfiles.gptsovits)?.description}>
                                <select
                                    className="field-control"
                                    value={ttsModelProfiles.gptsovits}
                                    onChange={(e) => handleTtsModelProfileChange('gptsovits', e.target.value)}
                                >
                                    {TTS_MODEL_PROFILES.gptsovits.map(option => (
                                        <option key={option.id} value={option.id} style={{ background: '#1f2937' }}>{option.label}</option>
                                    ))}
                                </select>
                            </FieldBlock>

                            <FieldBlock label="参考音频" hint="用于零样本语音克隆。未指定时自动回退到工作流提取的参考音。">
                                <div className="readonly-input-row">
                                    <div className="readonly-input-row__field">
                                        <input
                                            className="readonly-input"
                                            type="text"
                                            value={formatBuiltinGptSovitsRefLabel(gptSovitsSettings.refAudio)}
                                            readOnly
                                            placeholder="未选择（自动回退到工作流参考音）"
                                        />
                                        {gptSovitsSettings.refAudio && (
                                            <button
                                                onClick={() => setGptSovitsSettings(prev => ({ ...prev, refAudio: GPT_SOVITS_BUILTIN_VOICE_JING_YUAN, promptText: GPT_SOVITS_BUILTIN_PROMPT_JING_YUAN }))}
                                                title="清除参考音频"
                                                className="inline-clear"
                                            >
                                                ✕
                                            </button>
                                        )}
                                    </div>
                                    <button
                                        onClick={() => handleSelectFile((filePath) => setGptSovitsSettings(prev => ({ ...prev, refAudio: filePath })))}
                                        className="secondary-button secondary-button--primary"
                                    >
                                        选择音频
                                    </button>
                                </div>
                                <div className="form-actions" style={{ marginTop: '10px', justifyContent: 'flex-start' }}>
                                    <button
                                        onClick={() => setGptSovitsSettings(prev => ({ ...prev, refAudio: GPT_SOVITS_BUILTIN_VOICE_JING_YUAN, promptText: GPT_SOVITS_BUILTIN_PROMPT_JING_YUAN }))}
                                        className="secondary-button"
                                    >
                                        景元男声
                                    </button>
                                    <button
                                        onClick={() => setGptSovitsSettings(prev => ({ ...prev, refAudio: GPT_SOVITS_BUILTIN_VOICE_KAFKA, promptText: GPT_SOVITS_BUILTIN_PROMPT_KAFKA }))}
                                        className="secondary-button"
                                    >
                                        卡芙卡女声
                                    </button>
                                </div>
                            </FieldBlock>

                            <FieldBlock label="参考文本" hint="固定参考音色建议保留原始示例文本，自定义参考时填写对应转写。">
                                <textarea
                                    className="field-control"
                                    rows={4}
                                    value={gptSovitsSettings.promptText}
                                    onChange={(e) => setGptSovitsSettings(prev => ({ ...prev, promptText: e.target.value }))}
                                    placeholder="填写参考音频对应文本"
                                />
                            </FieldBlock>

                            <FieldBlock label="长文本切分" hint="长句启用官方式切分，短句由后端自动切换稳定模式。">
                                <select
                                    className="field-control"
                                    value={gptSovitsSettings.textSplitMethod}
                                    onChange={(e) => setGptSovitsSettings(prev => ({ ...prev, textSplitMethod: e.target.value as GptSovitsTtsSettings['textSplitMethod'] }))}
                                >
                                    <option value="cut0">cut0 / 不切分</option>
                                    <option value="cut1">cut1 / 四句一切</option>
                                    <option value="cut2">cut2 / 50 字一切</option>
                                    <option value="cut3">cut3 / 按中文句号</option>
                                    <option value="cut4">cut4 / 按英文句号</option>
                                    <option value="cut5">cut5 / 按标点</option>
                                </select>
                            </FieldBlock>
                        </div>

                        <div style={{ borderTop: isLightMode ? '1px solid #eee' : '1px solid #444', margin: '20px 0' }}></div>

                        <h3 style={{ marginTop: 0, marginBottom: '15px', color: isLightMode ? '#000' : '#fff' }}>优化参数</h3>

                        <SliderControl
                            label="语速倍率"
                            value={gptSovitsSettings.speedFactor}
                            setValue={(value) => setGptSovitsSettings(prev => ({ ...prev, speedFactor: value }))}
                            min={0.6} max={1.4} step={0.05}
                            desc="建议保持 1.0，过快会降低稳定性。"
                        />

                        <SliderControl
                            label="批量阈值"
                            value={gptSovitsSettings.batchThreshold}
                            setValue={(value) => setGptSovitsSettings(prev => ({ ...prev, batchThreshold: value }))}
                            min={0.1} max={3.0} step={0.1}
                            desc="基于 RTX 4070 实测，默认 1.2 更快更稳。"
                        />

                        <div className="slider-row">
                            <div className="slider-row__head">
                                <label>采样步数</label>
                                <span>{gptSovitsSettings.sampleSteps}</span>
                            </div>
                            <input
                                className="field-control"
                                type="number"
                                min={8}
                                max={64}
                                value={gptSovitsSettings.sampleSteps}
                                onChange={(e) => setGptSovitsSettings(prev => ({ ...prev, sampleSteps: Math.max(8, Number.parseInt(e.target.value || '28', 10) || 28) }))}
                            />
                            <p className="control-hint">基于 RTX 4070 实测，默认 28 更快。</p>
                        </div>

                        <label className="field-toggle">
                            <input
                                type="checkbox"
                                checked={gptSovitsSettings.parallelInfer}
                                onChange={(e) => setGptSovitsSettings(prev => ({ ...prev, parallelInfer: e.target.checked }))}
                            />
                            <span>长句批量加速</span>
                        </label>
                        <label className="field-toggle">
                            <input
                                type="checkbox"
                                checked={gptSovitsSettings.officialFastMode}
                                onChange={(e) => setGptSovitsSettings(prev => ({ ...prev, officialFastMode: e.target.checked }))}
                            />
                            <span>官方极速档</span>
                        </label>
                        <p className="control-hint" style={{ marginTop: '8px' }}>优先固定参考的大批量吞吐，减少保守缓冲与片段间隔，更接近官方演示速度。</p>
                        <p className="control-hint" style={{ marginTop: '8px' }}>固定官方示例音色时，系统会优先复用同一参考并自动把短句切回稳定模式。</p>

                        <div className="form-actions" style={{ marginTop: '20px' }}>
                            <button
                                onClick={() => handleSwitchService('gptsovits')}
                                disabled={activeService === 'gptsovits'}
                                className="secondary-button secondary-button--primary"
                            >
                                {activeService === 'gptsovits' ? '已启用' : '启用配置'}
                            </button>
                            <button
                                onClick={() => setIsResetDialogOpen(true)}
                                className="secondary-button secondary-button--danger"
                            >
                                恢复默认
                            </button>
                            <button
                                onClick={handleSaveGptSovits}
                                className="primary-button"
                            >
                                保存配置
                            </button>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="dense-grid dense-grid--single">
                            <FieldBlock label="模型档位" hint={TTS_MODEL_PROFILES.indextts.find(option => option.id === ttsModelProfiles.indextts)?.description}>
                            <select
                                className="field-control"
                                value={ttsModelProfiles.indextts}
                                onChange={(e) => handleTtsModelProfileChange('indextts', e.target.value)}
                            >
                                {TTS_MODEL_PROFILES.indextts.map(option => (
                                    <option key={option.id} value={option.id} style={{ background: '#1f2937' }}>{option.label}</option>
                                ))}
                            </select>
                            </FieldBlock>

                            <FieldBlock
                                label="参考音频"
                                hint={voiceMode === 'clone'
                                    ? '用于定义目标音色。未指定时将参考原视频片段。'
                                    : '用于定义整片音色。未指定时将自动提取统一参考音。'}
                            >
                                <div className="readonly-input-row">
                                    <div className="readonly-input-row__field">
                                        <input
                                            className="readonly-input"
                                            type="text"
                                            value={refAudioPath}
                                            readOnly
                                            placeholder={voiceMode === 'clone' ? '未选择（按片段参考原声）' : '未选择（自动提取统一参考音）'}
                                        />
                                        {refAudioPath && (
                                            <button
                                                onClick={() => {
                                                    setRefAudioPath('');
                                                    localStorage.removeItem('tts_ref_audio_path');
                                                }}
                                                title="清除参考音频"
                                                className="inline-clear"
                                            >
                                                ✕
                                            </button>
                                        )}
                                    </div>
                                    <button
                                        onClick={() => handleSelectFile(setRefAudioPath)}
                                        className="secondary-button secondary-button--primary"
                                    >
                                        选择音频
                                    </button>
                                </div>
                            </FieldBlock>

                            <div>
                                {refAudioPath
                                    ? <span className="status-inline status-inline--warn">已设置固定参考音频</span>
                                    : voiceMode === 'clone'
                                        ? <span className="status-inline">按片段参考原声</span>
                                        : <span className="status-inline">自动提取统一参考音</span>}
                            </div>
                        </div>

                        <div style={{ borderTop: isLightMode ? '1px solid #eee' : '1px solid #444', margin: '20px 0' }}></div>

                        <h3 style={{ marginTop: 0, marginBottom: '15px', color: isLightMode ? '#000' : '#fff' }}>高级参数</h3>

                        <SliderControl
                            label="Temperature"
                            value={temperature}
                            setValue={setTemperature}
                            min={0.1} max={1.5} step={0.1}
                            desc="控制生成多样性与表现强度。"
                        />

                        <SliderControl
                            label="Top P"
                            value={topP}
                            setValue={setTopP}
                            min={0.1} max={1.0} step={0.05}
                            desc="控制候选采样范围。"
                        />

                        <SliderControl
                            label="Repetition Penalty"
                            value={repetitionPenalty}
                            setValue={setRepetitionPenalty}
                            min={1.0} max={20.0} step={0.5}
                            desc="控制重复抑制强度。"
                        />

                        <SliderControl
                            label="CFG Scale"
                            value={cfgScale}
                            setValue={setCfgScale}
                            min={0.0} max={2.0} step={0.1}
                            desc="控制模型对提示条件的遵循程度。"
                        />



                        <SliderControl
                            label="Num Beams"
                            value={numBeams}
                            setValue={setNumBeams}
                            min={1} max={5} step={1}
                            desc="控制束搜索宽度。"
                        />

                        <SliderControl
                            label="Top K"
                            value={topK}
                            setValue={setTopK}
                            min={0} max={100} step={1}
                            desc="控制候选采样数量。"
                        />

                        <SliderControl
                            label="Length Penalty"
                            value={lengthPenalty}
                            setValue={setLengthPenalty}
                            min={0.0} max={2.0} step={0.1}
                            desc="控制生成长度偏好。"
                        />

                        <div className="slider-row">
                            <div className="slider-row__head">
                                <label>Max Mel Tokens</label>
                                <span>{maxMelTokens}</span>
                            </div>
                            <input
                                className="field-control"
                                type="number"
                                value={maxMelTokens}
                                onChange={(e) => setMaxMelTokens(parseInt(e.target.value))}
                            />
                            <p className="control-hint">控制单段生成长度上限。</p>
                        </div>

                        <div className="form-actions" style={{ marginTop: '20px' }}>
                            <button
                                onClick={() => handleSwitchService('indextts')}
                                disabled={activeService === 'indextts'}
                                className="secondary-button secondary-button--primary"
                            >
                                {activeService === 'indextts' ? '已启用' : '启用配置'}
                            </button>
                            <button
                                onClick={() => setIsResetDialogOpen(true)}
                                className="secondary-button secondary-button--danger"
                            >
                                恢复默认
                            </button>
                            <button
                                onClick={handleSaveIndex}
                                className="primary-button"
                            >
                                保存配置
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default TTSConfig;

