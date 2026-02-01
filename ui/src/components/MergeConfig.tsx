
import React from 'react';

interface MergeConfigProps {
    themeMode?: 'light' | 'dark' | 'gradient';
    videoStrategy: string;
    setVideoStrategy: (strategy: string) => void;
}

const MergeConfig: React.FC<MergeConfigProps> = ({ themeMode, videoStrategy, setVideoStrategy }) => {
    const isLightMode = themeMode === 'gradient' || themeMode === 'light';

    // Strategy options with detailed descriptions
    const strategyOptions = [
        {
            value: 'auto_speedup',
            label: '自动加速 (默认)',
            description: '自动调整音频播放速度以匹配视频画面时长。适合大多数对口型要求不高的场景，处理速度快。'
        },
        {
            value: 'frame_blend',
            label: '帧混合 (Frame Blending)',
            description: '通过混合相邻帧来平滑过渡。适合只需微调时长的情况，可能会产生轻微的重影。'
        },
        {
            value: 'freeze_frame',
            label: '冻结帧 (Freeze Frame)',
            description: '通过重复最后一帧来延长视频画面。适合PPT讲解或静态画面较多的视频。'
        },
        {
            value: 'rife',
            label: 'RIFE 智能补帧',
            description: '使用 AI 模型生成中间帧，实现流畅的慢动作效果。画质最好，但处理速度最慢，需要较好的显卡。'
        },
    ];

    return (
        <div style={{
            height: '100%',
            overflowY: 'auto',
            paddingRight: '10px',
            color: isLightMode ? '#333' : '#fff'
        }}>
            <h2 style={{ fontSize: '1.5em', fontWeight: 'bold', marginBottom: '20px' }}>合并配置</h2>

            {/* Strategy Card */}
            <div className={`glass-card ${isLightMode ? 'light-mode' : ''}`} style={{ padding: '20px', marginBottom: '20px' }}>
                <h3 style={{ fontSize: '1.1em', fontWeight: 'bold', marginBottom: '15px' }}>视频对齐策略</h3>
                <div style={{ fontSize: '0.9em', color: isLightMode ? '#666' : '#aaa', marginBottom: '15px' }}>
                    选择在音频时长与视频画面不一致时，如何调整视频以保持同步。
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                    {strategyOptions.map((option) => (
                        <div
                            key={option.value}
                            onClick={() => setVideoStrategy(option.value)}
                            style={{
                                padding: '15px',
                                borderRadius: '12px',
                                background: videoStrategy === option.value
                                    ? (isLightMode ? 'rgba(99, 102, 241, 0.1)' : 'rgba(99, 102, 241, 0.2)')
                                    : (isLightMode ? 'rgba(255, 255, 255, 0.5)' : 'rgba(30, 41, 59, 0.4)'),
                                border: videoStrategy === option.value
                                    ? '2px solid #6366f1'
                                    : (isLightMode ? '1px solid rgba(0,0,0,0.1)' : '1px solid rgba(255,255,255,0.1)'),
                                cursor: 'pointer',
                                transition: 'all 0.2s ease'
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '5px' }}>
                                <div style={{
                                    width: '18px',
                                    height: '18px',
                                    borderRadius: '50%',
                                    border: videoStrategy === option.value ? '5px solid #6366f1' : '2px solid #ccc',
                                    marginRight: '10px',
                                    background: 'transparent',
                                    flexShrink: 0
                                }} />
                                <span style={{ fontWeight: 'bold', fontSize: '1em' }}>{option.label}</span>
                            </div>
                            <div style={{ marginLeft: '28px', fontSize: '0.9em', color: isLightMode ? '#666' : '#aaa' }}>
                                {option.description}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default MergeConfig;
