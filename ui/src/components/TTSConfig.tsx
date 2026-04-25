
import React, { useState, useEffect } from 'react';
import QwenTTSConfig from './QwenTTSConfig';
import ConfirmDialog from './ConfirmDialog';
import type { TtsVoiceMode } from '../utils/runtimeSettings';

interface TTSConfigProps {
    themeMode?: 'light' | 'dark' | 'gradient';
    activeService: 'indextts' | 'qwen';
    onServiceChange: (service: 'indextts' | 'qwen') => Promise<boolean>;
    onQwenModeChange: (mode: 'clone' | 'design' | 'preset') => void;
    batchSize: number;
    setBatchSize: (size: number) => void;
    cloneBatchSize: number;
    setCloneBatchSize: (size: number) => void;
    maxNewTokens: number;
    setMaxNewTokens: (token: number) => void;
}

const TTSConfig: React.FC<TTSConfigProps> = ({ themeMode, activeService, onServiceChange, onQwenModeChange, batchSize, setBatchSize, cloneBatchSize, setCloneBatchSize, maxNewTokens, setMaxNewTokens }) => {
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
        return (localStorage.getItem('last_tts_view') as any) || activeService || 'indextts';
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

        if (activeService) {
            // If we just mounted, ensuring viewMode syncs if desired not strictly needed if we use localStorage
        }
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
        setFeedback({ title: '保存成功', message: 'IndexTTS 配置已保存！', type: 'success' });
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
        localStorage.removeItem('tts_ref_audio_path');
        // also reset other keys if needed? 
        // For now just ref audio is the main one persisted separately
        setIsResetDialogOpen(false);
    };

    const handleSelectFile = async () => {
        try {
            const result = await window.api.openFileDialog({
                filters: [{ name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'm4a'] }]
            });
            if (result && !result.canceled && result.filePaths.length > 0) {
                setRefAudioPath(result.filePaths[0]);
            }
        } catch (e) {
            console.error(e);
        }
    };

    const handleSwitchService = async (target: 'indextts' | 'qwen') => {
        if (target === activeService) return;

        setSwitching(true);
        setSwitchStatus('正在切换运行环境...');

        try {
            const success = await onServiceChange(target);
            if (!success) {
                return;
            }
        } catch (e) {
            console.error(e);
            setSwitchStatus('切换失败');
            setFeedback({ title: '切换失败', message: '切换环境失败，请查看日志。', type: 'error' });
            return;
        } finally {
            setSwitchStatus('');
            setSwitching(false);
        }
    };

    const SliderControl = ({ label, value, setValue, min, max, step, desc }: any) => (
        <div style={{ marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <label style={{ fontWeight: 'bold' }}>{label}</label>
                <span style={{ fontWeight: 'bold', color: '#6366f1' }}>{value}</span>
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
            {desc && <p style={{ fontSize: '0.8em', color: isLightMode ? '#666' : '#aaa', margin: '5px 0 0 0' }}>{desc}</p>}
        </div>
    );

    return (
        <div style={{ padding: '20px', height: '100%', overflowY: 'auto', color: isLightMode ? '#333' : '#fff' }}>

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

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h2 style={{ margin: 0, color: isLightMode ? '#000' : '#fff' }}>
                    🗣️ {viewMode === 'qwen' ? 'Qwen3-TTS' : 'Index-TTS'} 配置
                </h2>

                <div style={{ background: isLightMode ? '#eee' : '#333', borderRadius: '20px', padding: '4px', display: 'flex' }}>
                    <button
                        onClick={() => setViewMode('indextts')}
                        style={{
                            background: viewMode === 'indextts' ? '#6366f1' : 'transparent',
                            color: viewMode === 'indextts' ? '#fff' : (isLightMode ? '#666' : '#aaa'),
                            border: 'none',
                            borderRadius: '16px',
                            padding: '6px 16px',
                            cursor: 'pointer',
                            fontWeight: 'bold',
                            transition: 'all 0.2s',
                            display: 'flex', alignItems: 'center', gap: '5px'
                        }}
                    >
                        {activeService === 'indextts' && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 5px #22c55e' }}></span>} Index-TTS
                    </button>
                    <button
                        onClick={() => setViewMode('qwen')}
                        style={{
                            background: viewMode === 'qwen' ? '#6366f1' : 'transparent',
                            color: viewMode === 'qwen' ? '#fff' : (isLightMode ? '#666' : '#aaa'),
                            border: 'none',
                            borderRadius: '16px',
                            padding: '6px 16px',
                            cursor: 'pointer',
                            fontWeight: 'bold',
                            transition: 'all 0.2s',
                            display: 'flex', alignItems: 'center', gap: '5px'
                        }}
                    >
                        {activeService === 'qwen' && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 5px #22c55e' }}></span>} Qwen3-TTS
                    </button>
                </div>
            </div>

            {switching && (
                <div style={{ padding: '20px', background: 'rgba(255, 165, 0, 0.2)', borderRadius: '8px', marginBottom: '20px', textAlign: 'center' }}>
                    <div className="spinner" style={{ display: 'inline-block', width: '20px', height: '20px', border: '3px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 1s linear infinite', marginRight: '10px' }}></div>
                    {switchStatus}
                    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                </div>
            )}

            <div className="glass-panel" style={{ padding: '20px', marginBottom: '20px', background: isLightMode ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)' }}>
                <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>声音模式</label>
                    <div style={{ background: isLightMode ? '#ddd' : '#444', borderRadius: '10px', padding: '3px', display: 'inline-flex' }}>
                        <button
                            onClick={() => setVoiceMode('clone')}
                            style={{
                                background: voiceMode === 'clone' ? '#6366f1' : 'transparent',
                                color: voiceMode === 'clone' ? '#fff' : (isLightMode ? '#333' : '#aaa'),
                                border: 'none',
                                borderRadius: '8px',
                                padding: '6px 14px',
                                cursor: 'pointer',
                                fontWeight: 'bold'
                            }}
                        >
                            克隆模式
                        </button>
                        <button
                            onClick={() => setVoiceMode('narration')}
                            style={{
                                background: voiceMode === 'narration' ? '#6366f1' : 'transparent',
                                color: voiceMode === 'narration' ? '#fff' : (isLightMode ? '#333' : '#aaa'),
                                border: 'none',
                                borderRadius: '8px',
                                padding: '6px 14px',
                                cursor: 'pointer',
                                fontWeight: 'bold'
                            }}
                        >
                            朗读模式
                        </button>
                    </div>
                    <p style={{ fontSize: '0.85em', color: isLightMode ? '#666' : '#aaa', marginTop: '8px' }}>
                        {voiceMode === 'clone'
                            ? '逐句参考源视频或指定参考音频，尽量贴近原说话人的音色与节奏。'
                            : '全程使用同一个固定声音，不再逐句取源视频参考，速度更快且音色更统一。'}
                    </p>
                </div>

                {viewMode === 'qwen' ? (
                    <QwenTTSConfig
                        themeMode={themeMode}
                        voiceMode={voiceMode}
                        isActive={activeService === 'qwen'}
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
                        <h3 style={{ marginTop: 0, marginBottom: '15px', color: isLightMode ? '#000' : '#fff' }}>基础设置</h3>

                        <div style={{ marginBottom: '20px' }}>
                            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>参考音频 (Reference Audio)</label>
                            <p style={{ fontSize: '0.9em', color: isLightMode ? '#666' : '#aaa', marginBottom: '10px' }}>
                                {voiceMode === 'clone'
                                    ? '用于由 AI 克隆音色的目标声音文件 (3-10秒 wav/mp3)。不指定时，将逐句使用原视频对应片段做参考。'
                                    : '用于固定整部视频的朗读音色 (3-10秒 wav/mp3)。不指定时，将自动从原视频中选取一段全局参考音频并全程复用。'}
                            </p>
                            <div style={{ display: 'flex', gap: '10px' }}>
                                <div style={{ flex: 1, position: 'relative' }}>
                                    <input
                                        type="text"
                                        value={refAudioPath}
                                        readOnly
                                        placeholder={voiceMode === 'clone' ? '未选择 (自动使用当前片段原音)' : '未选择 (自动提取一个全局固定参考音)'}
                                        style={{
                                            width: '100%',
                                            padding: '8px',
                                            paddingRight: '30px',
                                            borderRadius: '4px',
                                            border: '1px solid #ccc',
                                            background: isLightMode ? '#f3f4f6' : 'rgba(0,0,0,0.2)',
                                            color: isLightMode ? '#000' : '#fff',
                                            cursor: 'not-allowed',
                                            boxSizing: 'border-box'
                                        }}
                                    />
                                    {refAudioPath && (
                                        <button
                                            onClick={() => {
                                                setRefAudioPath('');
                                                localStorage.removeItem('tts_ref_audio_path');
                                            }}
                                            title="清除自定义引用，恢复自动"
                                            style={{
                                                position: 'absolute',
                                                right: '5px',
                                                top: '50%',
                                                transform: 'translateY(-50%)',
                                                background: 'transparent',
                                                border: 'none',
                                                cursor: 'pointer',
                                                color: '#ef4444',
                                                fontSize: '1.2em'
                                            }}
                                        >
                                            ✕
                                        </button>
                                    )}
                                </div>
                                <button
                                    onClick={handleSelectFile}
                                    style={{
                                        padding: '8px 16px',
                                        background: '#3b82f6',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        cursor: 'pointer',
                                        whiteSpace: 'nowrap'
                                    }}
                                >
                                    📂 选择文件
                                </button>
                            </div>
                            <p style={{ fontSize: '0.8em', color: '#10b981', marginTop: '5px' }}>
                                {refAudioPath
                                    ? '⚠️ 已设置固定参考音频。'
                                    : voiceMode === 'clone'
                                        ? '✅ 克隆模式: 每个片段将使用自身对应的原视频语音作为参考。'
                                        : '✅ 朗读模式: 系统将自动选取一个全局参考音频并在所有片段中复用。'}
                            </p>
                        </div>

                        <div style={{ borderTop: isLightMode ? '1px solid #eee' : '1px solid #444', margin: '20px 0' }}></div>

                        <h3 style={{ marginTop: 0, marginBottom: '15px', color: isLightMode ? '#000' : '#fff' }}>高级生成参数</h3>

                        <SliderControl
                            label="Temperature (随机性)"
                            value={temperature}
                            setValue={setTemperature}
                            min={0.1} max={1.5} step={0.1}
                            desc="控制生成结果的随机性。数值越高(>0.8)，语气情感越丰富，但可能不稳定；数值越低(<0.5)，声音越平稳单一。"
                        />

                        <SliderControl
                            label="Top P (采样范围)"
                            value={topP}
                            setValue={setTopP}
                            min={0.1} max={1.0} step={0.05}
                            desc="控制候选词的概率阈值。较低的值（如 0.5）会使模型更加保守和准确，较高的值（如 0.9）会增加变化性。"
                        />

                        <SliderControl
                            label="Repetition Penalty"
                            value={repetitionPenalty}
                            setValue={setRepetitionPenalty}
                            min={1.0} max={20.0} step={0.5}
                            desc="重复惩罚系数。如果发现生成的语音有结巴或重复现象，可适当调高此值（建议 1.0 - 2.0）。"
                        />

                        <SliderControl
                            label="CFG Scale"
                            value={cfgScale}
                            setValue={setCfgScale}
                            min={0.0} max={2.0} step={0.1}
                            desc="引导系数（类似于 SD）。控制模型多大程度上遵循提示。IndexTTS 中通常保持默认 0.7 即可。"
                        />



                        <SliderControl
                            label="Num Beams (束搜索数量)"
                            value={numBeams}
                            setValue={setNumBeams}
                            min={1} max={5} step={1}
                            desc="Beam Search 的束宽。1 为贪婪搜索/采样。大于 1 可提高质量但显著降低速度。"
                        />

                        <SliderControl
                            label="Top K"
                            value={topK}
                            setValue={setTopK}
                            min={0} max={100} step={1}
                            desc="仅从概率最高的 K 个词中采样。配合 Top P 使用。"
                        />

                        <SliderControl
                            label="Length Penalty (长度惩罚)"
                            value={lengthPenalty}
                            setValue={setLengthPenalty}
                            min={0.0} max={2.0} step={0.1}
                            desc=">1.0 鼓励生成更长的序列，<1.0 鼓励生成更短的序列。"
                        />

                        <div style={{ marginBottom: '20px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                                <label style={{ fontWeight: 'bold' }}>Max Mel Tokens (最大长度限制)</label>
                                <span style={{ fontWeight: 'bold', color: '#6366f1' }}>{maxMelTokens}</span>
                            </div>
                            <input
                                type="number"
                                value={maxMelTokens}
                                onChange={(e) => setMaxMelTokens(parseInt(e.target.value))}
                                style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', background: isLightMode ? '#fff' : '#333', color: isLightMode ? '#000' : '#fff' }}
                            />
                            <p style={{ fontSize: '0.8em', color: isLightMode ? '#666' : '#aaa', margin: '5px 0 0 0' }}>生成的最大 Mel 帧数限制 (1 token ≈ 10-20ms)。防止无限生成。</p>
                        </div>

                        <div style={{ marginTop: '20px', textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: '10px', alignItems: 'center' }}>
                            <button
                                onClick={() => handleSwitchService('indextts')}
                                disabled={activeService === 'indextts'}
                                style={{
                                    padding: '10px 24px',
                                    background: activeService === 'indextts' ? '#4b5563' : '#3b82f6',
                                    color: 'white',
                                    borderRadius: '4px',
                                    cursor: activeService === 'indextts' ? 'default' : 'pointer',
                                    fontWeight: 'bold',
                                    opacity: activeService === 'indextts' ? 1 : 0.8,
                                    boxShadow: activeService === 'indextts' ? '0 0 10px #22c55e' : 'none',
                                    border: activeService === 'indextts' ? '2px solid #22c55e' : 'none'
                                }}
                            >
                                {activeService === 'indextts' ? '✅ 当前已激活' : '⚡ 启用此配置'}
                            </button>
                            <button
                                onClick={() => setIsResetDialogOpen(true)}
                                style={{
                                    padding: '10px 24px',
                                    background: '#ef4444',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    fontWeight: 'bold'
                                }}
                            >
                                ↺ 恢复默认
                            </button>
                            <button
                                onClick={handleSaveIndex}
                                style={{
                                    padding: '10px 24px',
                                    background: '#10b981',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    fontWeight: 'bold'
                                }}
                            >
                                💾 保存配置
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default TTSConfig;

