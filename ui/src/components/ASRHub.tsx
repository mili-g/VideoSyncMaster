import React, { useState, useEffect } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { ASR_SERVICE_META, SUPPORTED_ASR_SERVICES, type AsrService } from '../utils/asrService';

interface ASRHubProps {
    themeMode?: 'light' | 'dark' | 'gradient';
    asrService: string;
    onServiceChange: (service: AsrService) => boolean;
}

const ASRHub: React.FC<ASRHubProps> = ({ themeMode, asrService, onServiceChange }) => {
    const isLightMode = themeMode === 'gradient' || themeMode === 'light';
    const currentService = (asrService in ASR_SERVICE_META ? asrService : 'jianying') as AsrService;

    // Whisper Settings
    const [vadOnset, setVadOnset] = useState<number>(0.700);
    const [vadOffset, setVadOffset] = useState<number>(0.700);

    // Qwen Settings
    const [qwenModel, setQwenModel] = useState<string>('Qwen3-ASR-1.7B');
    const [qwenDevice, setQwenDevice] = useState<string>('cuda');

    const [showSaveConfirm, setShowSaveConfirm] = useState(false);

    useEffect(() => {
        const storedOnset = localStorage.getItem('whisper_vad_onset');
        if (storedOnset) setVadOnset(parseFloat(storedOnset));

        const storedOffset = localStorage.getItem('whisper_vad_offset');
        if (storedOffset) setVadOffset(parseFloat(storedOffset));

        const storedQwenModel = localStorage.getItem('qwen_asr_model');
        if (storedQwenModel) setQwenModel(storedQwenModel);

        const storedQwenDevice = localStorage.getItem('qwen_asr_device');
        if (storedQwenDevice) setQwenDevice(storedQwenDevice);
    }, []);

    const handleSave = () => {
        localStorage.setItem('whisper_vad_onset', vadOnset.toString());
        localStorage.setItem('whisper_vad_offset', vadOffset.toString());
        localStorage.setItem('qwen_asr_model', qwenModel);
        localStorage.setItem('qwen_asr_device', qwenDevice);
        setShowSaveConfirm(true);
    };

    const SelectControl = ({ label, value, setValue, options, desc }: any) => (
        <div style={{ marginBottom: '20px' }}>
            <label style={{ fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>{label}</label>
            <select
                value={value}
                onChange={(e) => setValue(e.target.value)}
                style={{
                    width: '100%',
                    padding: '10px',
                    borderRadius: '8px',
                    background: 'rgba(255,255,255,0.05)',
                    color: isLightMode ? '#333' : '#fff',
                    border: '1px solid rgba(255,255,255,0.1)',
                    outline: 'none'
                }}
            >
                {options.map((opt: any) => (
                    <option key={opt.value} value={opt.value} style={{ background: '#1f2937' }}>{opt.label}</option>
                ))}
            </select>
            {desc && <p style={{ fontSize: '0.8em', color: isLightMode ? '#666' : '#aaa', margin: '5px 0 0 0' }}>{desc}</p>}
        </div>
    );

    const SliderControl = ({ label, value, setValue, min, max, step, desc, disabled }: any) => (
        <div style={{ marginBottom: '20px', opacity: disabled ? 0.5 : 1, transition: 'opacity 0.2s' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <label style={{ fontWeight: 'bold' }}>{label}</label>
                <span style={{ fontWeight: 'bold', color: disabled ? '#888' : '#6366f1' }}>{value.toFixed(3)}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => !disabled && setValue(parseFloat(e.target.value))}
                disabled={disabled}
                style={{ width: '100%', cursor: disabled ? 'not-allowed' : 'pointer' }}
            />
            {desc && <p style={{ fontSize: '0.8em', color: isLightMode ? '#666' : '#aaa', margin: '5px 0 0 0' }}>{desc}</p>}
        </div>
    );

    return (
        <div style={{ padding: '30px', height: '100%', overflowY: 'auto', color: isLightMode ? '#333' : '#fff' }}>
            <h1 style={{ marginBottom: '10px', fontSize: '2em' }}>🎙️ 识别中心 (ASR Hub)</h1>
            <p style={{ marginBottom: '30px', color: isLightMode ? '#666' : '#aaa' }}>
                在此配置语音识别引擎。不同的引擎适用于不同的场景（本地、云端、长视频等）。
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '25px' }}>

                {/* Engine Selection Card */}
                <div className="glass-panel" style={{ padding: '20px', background: 'rgba(99, 102, 241, 0.1)', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
                    <h3 style={{ marginTop: 0 }}>默认识别引擎</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '15px' }}>
                        {SUPPORTED_ASR_SERVICES.map((serviceId) => {
                            const engine = ASR_SERVICE_META[serviceId];
                            return (
                            <div
                                key={engine.id}
                                onClick={() => onServiceChange(engine.id)}
                                style={{
                                    padding: '12px',
                                    borderRadius: '12px',
                                    background: currentService === engine.id ? 'rgba(99, 102, 241, 0.2)' : 'rgba(255,255,255,0.05)',
                                    border: `2px solid ${currentService === engine.id ? '#6366f1' : 'transparent'}`,
                                    cursor: 'pointer',
                                    transition: 'all 0.2s'
                                }}
                            >
                                <div style={{ fontWeight: 'bold' }}>{engine.name}</div>
                                <div style={{ fontSize: '0.8em', opacity: 0.7 }}>{engine.description}</div>
                            </div>
                            );
                        })}
                    </div>
                </div>

                {/* Unified Settings Card */}
                <div className="glass-panel" style={{ padding: '20px', border: '1px solid rgba(99, 102, 241, 0.3)' }}>
                    {currentService === 'qwen' ? (
                        <>
                            <h3 style={{ marginBottom: '15px' }}>模型参数 (Qwen3-ASR)</h3>
                            <SelectControl
                                label="模型版本 (Model Size)"
                                value={qwenModel}
                                setValue={setQwenModel}
                                options={[
                                    { label: 'Qwen3-ASR-1.7B (推荐)', value: 'Qwen3-ASR-1.7B' },
                                    { label: 'Qwen3-ASR-0.6B (超快)', value: 'Qwen3-ASR-0.6B' }
                                ]}
                                desc="1.7B 精度更高，0.6B 占用显存极小且速度快。"
                            />
                            <SelectControl
                                label="计算设备 (Inference Device)"
                                value={qwenDevice}
                                setValue={setQwenDevice}
                                options={[
                                    { label: 'CUDA (NVIDIA GPU)', value: 'cuda' },
                                    { label: 'CPU (普通模式)', value: 'cpu' }
                                ]}
                                desc="建议优先使用 CUDA 以获得最佳性能。"
                            />
                        </>
                    ) : currentService === 'whisperx' ? (
                        <>
                            <h3 style={{ margin: '0 0 15px 0' }}>VAD 配置 (WhisperX Only)</h3>
                            <SliderControl
                                label="VAD Onset (开始阈值)"
                                value={vadOnset}
                                setValue={setVadOnset}
                                min={0.1}
                                max={1.0}
                                step={0.001}
                                desc="语音开始检测阈值。默认 0.700。"
                                disabled={currentService !== 'whisperx'}
                            />
                            <SliderControl
                                label="VAD Offset (结束阈值)"
                                value={vadOffset}
                                setValue={setVadOffset}
                                min={0.1}
                                max={1.0}
                                step={0.001}
                                desc="语音结束检测阈值。默认 0.700。"
                                disabled={false}
                            />
                        </>
                    ) : (
                        <>
                            <h3 style={{ margin: '0 0 15px 0' }}>{ASR_SERVICE_META[currentService].detailTitle}</h3>
                            <div
                                style={{
                                    borderRadius: '14px',
                                    padding: '16px',
                                    background: 'rgba(255,255,255,0.04)',
                                    border: '1px solid rgba(255,255,255,0.08)',
                                    lineHeight: '1.7'
                                }}
                            >
                                <div style={{ fontWeight: 700, marginBottom: '8px' }}>{ASR_SERVICE_META[currentService].name}</div>
                                <div style={{ color: isLightMode ? '#555' : '#d1d5db', fontSize: '0.95em' }}>
                                    {ASR_SERVICE_META[currentService].detailBody}
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* Info Card */}
                <div className="glass-panel" style={{ padding: '20px', background: 'rgba(255,255,255,0.05)' }}>
                    <h3 style={{ marginTop: 0 }}>引擎说明</h3>
                    <ul style={{ paddingLeft: '20px', fontSize: '0.9em', lineHeight: '1.6' }}>
                        <li><b>剪映 API</b>: 云端识别，速度快，适合中文长视频与快速出稿。</li>
                        <li><b>必剪 API</b>: 云端识别，稳定性更好，适合通用视频类型。</li>
                        <li><b>WhisperX</b>: 本地运行，支持强制对齐与 VAD 微调。</li>
                        <li><b>Qwen3 ASR</b>: 本地端到端语音模型，适合多语种内容。</li>
                    </ul>
                    <p style={{ fontSize: '0.85em', color: '#aaa', marginTop: '10px' }}>
                        默认推荐云端接口；本地引擎更适合需要精细控制模型与时间轴的场景。
                    </p>
                </div>

            </div>

            <div style={{ marginTop: '40px', display: 'flex', justifyContent: 'center' }}>
                <button
                    onClick={handleSave}
                    style={{
                        padding: '12px 40px',
                        background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                        color: 'white',
                        border: 'none',
                        borderRadius: '30px',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        fontSize: '1.1em',
                        boxShadow: '0 10px 20px rgba(16, 185, 129, 0.3)'
                    }}
                >
                    💾 保存所有识别配置
                </button>
            </div>

            <ConfirmDialog
                isOpen={showSaveConfirm}
                title="配置已保存"
                message="所有识别相关的配置已成功持久化。"
                onConfirm={() => setShowSaveConfirm(false)}
                isLightMode={isLightMode}
                confirmText="我知道了"
                confirmColor="#10b981"
            />
        </div>
    );
};

export default ASRHub;
