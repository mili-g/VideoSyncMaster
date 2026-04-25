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
    description: string;
    badge?: string;
}

const audioMixOptions: Array<OptionCard & { value: AudioMixMode }> = [
    {
        value: 'preserve_background',
        label: '保留背景音',
        description: '先将原视频音轨分离为人声和背景，再丢弃原旁白，只保留背景音轨并叠加新配音。',
        badge: '默认'
    },
    {
        value: 'replace_original',
        label: '完全替换原音轨',
        description: '只保留新生成的配音，不再保留原视频中的背景音和原始人声。适合需要纯净配音的场景。'
    }
];

const strategyOptions: OptionCard[] = [
    {
        value: 'auto_speedup',
        label: '自动加速',
        description: '当配音略长时自动加速音频，处理速度快，适合大多数批处理场景。',
        badge: '推荐'
    },
    {
        value: 'frame_blend',
        label: '帧混合',
        description: '通过补间和平滑过渡延长画面，适合只需要轻微拉长视频时长的内容。'
    },
    {
        value: 'freeze_frame',
        label: '冻结尾帧',
        description: '在必要时停留最后一帧来换取更长的配音空间，适合讲解类、PPT 类画面。'
    },
    {
        value: 'rife',
        label: 'RIFE 智能补帧',
        description: '用 AI 方式生成中间帧，画面更顺滑，但速度最慢，对硬件要求也更高。'
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
            <div style={{ marginLeft: '28px', fontSize: '0.92rem', lineHeight: 1.6, color: isLightMode ? '#475569' : '#94a3b8' }}>
                {option.description}
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
                <p style={{ margin: '0 0 16px 0', lineHeight: 1.7, color: isLightMode ? '#475569' : '#94a3b8' }}>
                    决定最终成片是保留原视频背景音，还是直接用新配音替换原始音轨。默认推荐保留背景音。
                </p>
                <div style={{ display: 'grid', gap: '14px' }}>
                    {audioMixOptions.map((option) => renderOption(option, audioMixMode, isLightMode, () => setAudioMixMode(option.value)))}
                </div>
            </div>

            <div style={sectionCardStyle(isLightMode)}>
                <h3 style={{ fontSize: '1.08rem', fontWeight: 700, marginBottom: '10px' }}>视频对齐策略</h3>
                <p style={{ margin: '0 0 16px 0', lineHeight: 1.7, color: isLightMode ? '#475569' : '#94a3b8' }}>
                    当配音长度与原视频片段不一致时，决定如何调整视频时长来保持音画同步。
                </p>
                <div style={{ display: 'grid', gap: '14px' }}>
                    {strategyOptions.map((option) => renderOption(option, videoStrategy, isLightMode, () => setVideoStrategy(option.value)))}
                </div>
            </div>
        </div>
    );
};

export default MergeConfig;
