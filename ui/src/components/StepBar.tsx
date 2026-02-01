import React from 'react';

interface StepBarProps {
    currentStep: number; // 0: 视频, 1: 识别, 2: 翻译, 3: 配音, 4: 合成
    onStepChange?: (step: number) => void;
    themeMode?: 'light' | 'dark' | 'gradient';
}

const steps = [
    { name: '准备视频', icon: '🎬' },
    { name: '识别字幕', icon: '🎙️' },
    { name: '翻译字幕', icon: '🌐' },
    { name: '生成配音', icon: '🗣️' },
    { name: '导出合成', icon: '💾' }
];

const StepBar: React.FC<StepBarProps> = ({ currentStep, onStepChange, themeMode }) => {
    const isLightMode = themeMode === 'gradient' || themeMode === 'light';

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '12px 24px',
            background: isLightMode ? 'rgba(255, 255, 255, 0.5)' : 'rgba(15, 23, 42, 0.4)',
            backdropFilter: 'blur(20px)',
            borderRadius: '20px',
            border: isLightMode ? '1px solid rgba(0,0,0,0.05)' : '1px solid rgba(255, 255, 255, 0.05)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.1)',
            gap: '12px',
            marginBottom: '20px',
            alignSelf: 'center',
            zIndex: 100,
            transition: 'all 0.3s ease'
        }}>
            {steps.map((step, index) => {
                const isActive = currentStep === index;
                const isPast = currentStep > index;

                return (
                    <React.Fragment key={index}>
                        <div
                            onClick={() => onStepChange?.(index)}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                padding: '8px 16px',
                                borderRadius: '12px',
                                background: isActive ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                                border: isActive ? '1px solid rgba(99, 102, 241, 0.3)' : '1px solid transparent',
                                cursor: 'pointer',
                                transition: 'all 0.2s ease',
                                opacity: isActive || isPast ? 1 : 0.5,
                                transform: isActive ? 'translateY(-2px)' : 'none'
                            }}
                        >
                            <div style={{
                                width: '28px',
                                height: '28px',
                                borderRadius: '50%',
                                background: isPast ? '#10b981' : (isActive ? '#6366f1' : 'rgba(255,255,255,0.1)'),
                                color: '#fff',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '0.9em',
                                fontWeight: 'bold',
                                boxShadow: isActive ? '0 0 15px rgba(99, 102, 241, 0.4)' : 'none'
                            }}>
                                {isPast ? '✓' : index + 1}
                            </div>
                            <span style={{
                                fontSize: '0.9em',
                                fontWeight: isActive ? '700' : '500',
                                color: isActive ? (isLightMode ? '#4f46e5' : '#818cf8') : (isLightMode ? '#64748b' : '#94a3b8')
                            }}>
                                {step.name}
                            </span>
                        </div>
                        {index < steps.length - 1 && (
                            <div style={{
                                width: '30px',
                                height: '2px',
                                background: isPast ? 'linear-gradient(90deg, #10b981, #6366f1)' : 'rgba(255,255,255,0.1)',
                                flexShrink: 0
                            }} />
                        )}
                    </React.Fragment>
                );
            })}
        </div>
    );
};

export default StepBar;
