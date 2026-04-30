
import React, { useState, useEffect } from 'react';
import QwenTTSConfig from './QwenTTSConfig';
import ConfirmDialog from './ConfirmDialog';
import type { TtsVoiceMode } from '../utils/runtimeSettings';
import { TTS_MODEL_PROFILES } from '../utils/modelProfiles';
import { FieldBlock } from '../features/asr/shared';
import type { FileDialogResult } from '../types/backend';

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

interface TTSConfigProps {
    themeMode?: 'light' | 'dark' | 'gradient';
    activeService: 'indextts' | 'qwen';
    onServiceChange: (service: 'indextts' | 'qwen') => Promise<boolean>;
    ttsModelProfiles: Record<'indextts' | 'qwen', string>;
    setTtsModelProfiles: React.Dispatch<React.SetStateAction<Record<'indextts' | 'qwen', string>>>;
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
    setValue: React.Dispatch<React.SetStateAction<number>>;
    min: number;
    max: number;
    step: number;
    desc?: string;
}

const TTSConfig: React.FC<TTSConfigProps> = ({ themeMode, activeService, onServiceChange, ttsModelProfiles, setTtsModelProfiles, onQwenModeChange, batchSize, setBatchSize, cloneBatchSize, setCloneBatchSize, maxNewTokens, setMaxNewTokens }) => {
    const isLightMode = themeMode === 'gradient' || themeMode === 'light';

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

    // Switching State
    const [switching, setSwitching] = useState(false);
    const [switchStatus, setSwitchStatus] = useState('');

    // Dialog State
    const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
    const [feedback, setFeedback] = useState<{ title: string; message: string; type: 'success' | 'error' } | null>(null);
    const [voiceMode, setVoiceMode] = useState<TtsVoiceMode>(() => {
        const stored = localStorage.getItem('tts_voice_mode');
        return stored === 'narration' ? 'narration' : 'clone';
    });

    // View State (Separate from Active Service)
    const [viewMode, setViewMode] = useState<'indextts' | 'qwen'>(() => {
        const stored = localStorage.getItem('last_tts_view');
        return stored === 'qwen' || stored === 'indextts'
            ? stored
            : (activeService || 'indextts');
    });

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

    const handleSelectFile = async () => {
        try {
            const result = await window.api.openFileDialog({
                filters: [{ name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'm4a'] }]
            }) as FileDialogResult;
            if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                setRefAudioPath(result.filePaths[0]);
            }
        } catch (e) {
            console.error(e);
        }
    };

    const handleSwitchService = async (target: 'indextts' | 'qwen') => {
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

    const handleTtsModelProfileChange = (service: 'indextts' | 'qwen', profileId: string) => {
        setTtsModelProfiles(prev => ({
            ...prev,
            [service]: profileId
        }));
    };

    return (
        <div className="tool-panel" style={{ padding: '6px 2px', color: isLightMode ? '#333' : '#fff' }}>

            <ConfirmDialog
                isOpen={isResetDialogOpen}
                title="重置配置"
                message="确定要重置所有 Index-TTS 配置参数吗？此操作无法撤销。"
                onConfirm={confirmResetIndex}
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
                    <h3>{viewMode === 'qwen' ? 'Qwen3-TTS' : 'Index-TTS'}</h3>
                    <p>按引擎维度管理配音参数、模型档位与声音策略。</p>
                </div>

                <div className="segmented-control">
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
                </div>
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
                        <p>{voiceMode === 'clone'
                            ? '按片段参考原声或指定参考音频。'
                            : '以统一音色生成整片旁白。'}</p>
                    </div>
                    <div className="segmented-control">
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
                                        onClick={handleSelectFile}
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

                        <div style={{ marginBottom: '20px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                                <label style={{ fontWeight: 'bold' }}>Max Mel Tokens</label>
                                <span style={{ fontWeight: 'bold', color: '#6366f1' }}>{maxMelTokens}</span>
                            </div>
                            <input
                                type="number"
                                value={maxMelTokens}
                                onChange={(e) => setMaxMelTokens(parseInt(e.target.value))}
                                style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', background: isLightMode ? '#fff' : '#333', color: isLightMode ? '#000' : '#fff' }}
                            />
                            <p style={{ fontSize: '0.8em', color: isLightMode ? '#666' : '#aaa', margin: '5px 0 0 0' }}>控制单段生成长度上限。</p>
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

