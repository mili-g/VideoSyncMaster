import React, { useState, useEffect } from 'react';
import ConfirmDialog from './ConfirmDialog';

interface WhisperConfigProps {
    themeMode?: 'light' | 'dark' | 'gradient';
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

const WhisperConfig: React.FC<WhisperConfigProps> = ({ themeMode }) => {
    const isLightMode = themeMode === 'gradient' || themeMode === 'light';

    // Default values matching backend defaults
    const [vadOnset, setVadOnset] = useState<number>(0.700);
    const [vadOffset, setVadOffset] = useState<number>(0.700);
    const [showSaveConfirm, setShowSaveConfirm] = useState(false);
    const [showResetConfirm, setShowResetConfirm] = useState(false);

    // Load config from localStorage
    useEffect(() => {
        const storedOnset = localStorage.getItem('whisper_vad_onset');
        if (storedOnset) setVadOnset(parseFloat(storedOnset));

        const storedOffset = localStorage.getItem('whisper_vad_offset');
        if (storedOffset) setVadOffset(parseFloat(storedOffset));
    }, []);

    const handleSave = () => {
        localStorage.setItem('whisper_vad_onset', vadOnset.toString());
        localStorage.setItem('whisper_vad_offset', vadOffset.toString());
        setShowSaveConfirm(true);
    };

    const handleReset = () => {
        setShowResetConfirm(true);
    };

    const confirmResetAction = () => {
        setVadOnset(0.700);
        setVadOffset(0.700);
        localStorage.removeItem('whisper_vad_onset');
        localStorage.removeItem('whisper_vad_offset');
        setShowResetConfirm(false);
    };

    const SliderControl = ({ label, value, setValue, min, max, step, desc }: SliderControlProps) => (
        <div className="slider-row">
            <div className="slider-row__head">
                <label>{label}</label>
                <span>{value.toFixed(3)}</span>
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

    return (
        <div className="tool-panel" style={{ padding: '20px', height: '100%', overflowY: 'auto', color: isLightMode ? '#333' : '#fff' }}>
            <div className="tool-toolbar">
                <div className="tool-toolbar__title">
                    <h3>Whisper VAD 配置</h3>
                    <p>调整语音活动检测灵敏度，控制语音与静音的切分方式。</p>
                </div>
            </div>

            <div
                className="config-section"
                style={{ background: isLightMode ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)' }}
            >
                <SliderControl
                    label="VAD Onset (开始阈值)"
                    value={vadOnset}
                    setValue={setVadOnset}
                    min={0.1}
                    max={1.0}
                    step={0.001}
                    desc="语音开始的检测阈值。值越高，越难触发语音识别（包括更多的静音）；值越低，越敏感（可能误识别噪音）。默认 0.700。"
                />
                <SliderControl
                    label="VAD Offset (结束阈值)"
                    value={vadOffset}
                    setValue={setVadOffset}
                    min={0.1}
                    max={1.0}
                    step={0.001}
                    desc="语音结束的检测阈值。值越高，语音断句越快（切断尾音）；值越低，保留更多尾部静音。默认 0.700。"
                />
            </div>

            <div className="form-actions" style={{ marginTop: '8px' }}>
                <button
                    onClick={handleReset}
                    className="secondary-button secondary-button--danger"
                >
                    恢复默认
                </button>
                <button
                    onClick={handleSave}
                    className="primary-button"
                >
                    保存配置
                </button>
            </div>

            <ConfirmDialog
                isOpen={showSaveConfirm}
                title="系统提示"
                message="Whisper VAD 配置已保存！将在下次运行时生效。"
                onConfirm={() => setShowSaveConfirm(false)}
                isLightMode={isLightMode}
                confirmText="确定"
                onCancel={undefined}
                confirmColor="#10b981"
            />

            <ConfirmDialog
                isOpen={showResetConfirm}
                title="确认操作"
                message="确定要恢复默认配置吗？此操作不可撤销。"
                onConfirm={confirmResetAction}
                onCancel={() => setShowResetConfirm(false)}
                isLightMode={isLightMode}
                confirmText="确定恢复"
                cancelText="取消"
                confirmColor="#ef4444"
            />
        </div>
    );
};

export default WhisperConfig;
