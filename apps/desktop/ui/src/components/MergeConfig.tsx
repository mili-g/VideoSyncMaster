import React from 'react';
import type { AudioMixMode } from '../hooks/useVideoProject';

interface MergeConfigProps {
    themeMode?: 'light' | 'dark' | 'gradient';
    videoStrategy: string;
    audioMixMode: AudioMixMode;
    setVideoStrategy: (strategy: string) => void;
    setAudioMixMode: (mode: AudioMixMode) => void;
}

interface OptionCard {
    value: string;
    label: string;
    badge?: string;
}

const audioMixOptions: Array<OptionCard & { value: AudioMixMode }> = [
    {
        value: 'preserve_background',
        label: '保留背景音',
        badge: '默认'
    },
    {
        value: 'replace_original',
        label: '完全替换原音轨'
    }
];

const strategyOptions: OptionCard[] = [
    {
        value: 'auto_speedup',
        label: '自动加速',
        badge: '推荐'
    },
    {
        value: 'frame_blend',
        label: '帧混合'
    },
    {
        value: 'freeze_frame',
        label: '冻结尾帧'
    },
    {
        value: 'rife',
        label: 'RIFE 智能补帧'
    }
];

const sectionCardStyle = (isLightMode: boolean): React.CSSProperties => ({
    padding: '20px',
    marginBottom: '20px',
    borderRadius: '16px',
    background: isLightMode ? 'rgba(255, 255, 255, 0.72)' : 'rgba(15, 23, 42, 0.68)',
    border: isLightMode ? '1px solid rgba(15, 23, 42, 0.08)' : '1px solid rgba(148, 163, 184, 0.18)',
    boxShadow: isLightMode
        ? '0 18px 40px rgba(15, 23, 42, 0.08)'
        : '0 18px 40px rgba(2, 6, 23, 0.28)'
});

function renderOption(
    option: OptionCard,
    selectedValue: string,
    isLightMode: boolean,
    onSelect: () => void
) {
    const selected = selectedValue === option.value;

    return (
        <button
            key={option.value}
            type="button"
            onClick={onSelect}
            style={{
                width: '100%',
                textAlign: 'left',
                padding: '16px 18px',
                borderRadius: '14px',
                border: selected
                    ? '2px solid #22c55e'
                    : (isLightMode ? '1px solid rgba(15, 23, 42, 0.12)' : '1px solid rgba(148, 163, 184, 0.2)'),
                background: selected
                    ? (isLightMode ? 'rgba(34, 197, 94, 0.12)' : 'rgba(34, 197, 94, 0.18)')
                    : (isLightMode ? 'rgba(255, 255, 255, 0.88)' : 'rgba(30, 41, 59, 0.55)'),
                color: isLightMode ? '#0f172a' : '#e2e8f0',
                cursor: 'pointer',
                transition: 'all 0.2s ease'
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                <div
                    style={{
                        width: '18px',
                        height: '18px',
                        borderRadius: '50%',
                        border: selected ? '5px solid #22c55e' : '2px solid rgba(148, 163, 184, 0.7)',
                        flexShrink: 0
                    }}
                />
                <span style={{ fontWeight: 700, fontSize: '1rem' }}>{option.label}</span>
                {option.badge && (
                    <span
                        style={{
                            marginLeft: 'auto',
                            fontSize: '0.76rem',
                            padding: '2px 8px',
                            borderRadius: '999px',
                            background: selected ? '#16a34a' : 'rgba(148, 163, 184, 0.18)',
                            color: selected ? '#f8fafc' : (isLightMode ? '#334155' : '#cbd5e1')
                        }}
                    >
                        {option.badge}
                    </span>
                )}
            </div>
        </button>
    );
}

const MergeConfig: React.FC<MergeConfigProps> = ({
    themeMode,
    videoStrategy,
    audioMixMode,
    setVideoStrategy,
    setAudioMixMode
}) => {
    const isLightMode = themeMode === 'gradient' || themeMode === 'light';

    return (
        <div
            style={{
                height: '100%',
                overflowY: 'auto',
                paddingRight: '10px',
                color: isLightMode ? '#0f172a' : '#e2e8f0'
            }}
        >
            <h2 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '18px' }}>合成配置</h2>

            <div style={sectionCardStyle(isLightMode)}>
                <h3 style={{ fontSize: '1.08rem', fontWeight: 700, marginBottom: '10px' }}>音频合成方式</h3>
                <div style={{ display: 'grid', gap: '14px' }}>
                    {audioMixOptions.map((option) => renderOption(option, audioMixMode, isLightMode, () => setAudioMixMode(option.value)))}
                </div>
            </div>

            <div style={sectionCardStyle(isLightMode)}>
                <h3 style={{ fontSize: '1.08rem', fontWeight: 700, marginBottom: '10px' }}>视频对齐策略</h3>
                <div style={{ display: 'grid', gap: '14px' }}>
                    {strategyOptions.map((option) => renderOption(option, videoStrategy, isLightMode, () => setVideoStrategy(option.value)))}
                </div>
            </div>
        </div>
    );
};

export default MergeConfig;
