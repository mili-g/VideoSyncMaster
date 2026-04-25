import React from 'react';
import type { WorkflowStepState } from '../types/workflow';

interface StepBarProps {
    steps: WorkflowStepState[];
    activeStepKey: WorkflowStepState['key'];
    onStepChange?: (step: number) => void;
    themeMode?: 'light' | 'dark' | 'gradient';
    compact?: boolean;
    minimal?: boolean;
}

const StepBar: React.FC<StepBarProps> = ({ steps, activeStepKey, onStepChange, themeMode, compact = false, minimal = false }) => {
    const isLightMode = themeMode === 'gradient' || themeMode === 'light';

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: minimal ? '6px 10px' : compact ? '8px 14px' : '12px 24px',
            background: isLightMode ? 'rgba(255, 255, 255, 0.5)' : 'rgba(15, 23, 42, 0.4)',
            backdropFilter: 'blur(20px)',
            borderRadius: minimal ? '14px' : compact ? '16px' : '20px',
            border: isLightMode ? '1px solid rgba(0,0,0,0.05)' : '1px solid rgba(255, 255, 255, 0.05)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.1)',
            gap: minimal ? '6px' : compact ? '8px' : '12px',
            alignSelf: 'center',
            zIndex: 100,
            transition: 'all 0.3s ease'
        }}>
            {steps.map((step, index) => {
                const activeIndex = Math.max(steps.findIndex((item) => item.key === activeStepKey), 0);
                const isActive = activeStepKey === step.key;
                const isPast = activeIndex > index || step.status === 'done';
                const isBlocked = step.status === 'blocked' || step.status === 'error';
                const bubbleBackground = step.status === 'error'
                    ? '#ef4444'
                    : isPast
                        ? '#10b981'
                        : isActive
                            ? '#6366f1'
                            : 'rgba(255,255,255,0.1)';

                return (
                    <React.Fragment key={index}>
                        <div
                            onClick={() => onStepChange?.(index)}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: minimal ? '0' : compact ? '6px' : '8px',
                                padding: minimal ? '2px' : compact ? '6px 10px' : '8px 16px',
                                borderRadius: minimal ? '999px' : compact ? '10px' : '12px',
                                background: isActive ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                                border: isActive
                                    ? '1px solid rgba(99, 102, 241, 0.3)'
                                    : isBlocked
                                        ? '1px solid rgba(248,113,113,0.2)'
                                        : '1px solid transparent',
                                cursor: 'pointer',
                                transition: 'all 0.2s ease',
                                opacity: isActive || isPast || step.status === 'ready' ? 1 : 0.55,
                                transform: isActive ? 'translateY(-2px)' : 'none'
                            }}
                        >
                            <div style={{
                                width: minimal ? '18px' : compact ? '24px' : '28px',
                                height: minimal ? '18px' : compact ? '24px' : '28px',
                                borderRadius: '50%',
                                background: bubbleBackground,
                                color: '#fff',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: minimal ? '0.62em' : compact ? '0.78em' : '0.9em',
                                fontWeight: 'bold',
                                boxShadow: isActive ? '0 0 15px rgba(99, 102, 241, 0.4)' : 'none'
                            }}>
                                {step.status === 'error' ? '!' : isPast ? '✓' : index + 1}
                            </div>
                            {!minimal && (
                                <span style={{
                                    fontSize: compact ? '0.8em' : '0.9em',
                                    fontWeight: isActive ? '700' : '500',
                                    color: step.status === 'error'
                                        ? '#fca5a5'
                                        : isActive
                                            ? (isLightMode ? '#4f46e5' : '#818cf8')
                                            : (isLightMode ? '#64748b' : '#94a3b8')
                                }}>
                                    {step.label}
                                </span>
                            )}
                        </div>
                        {index < steps.length - 1 && (
                            <div style={{
                                width: minimal ? '10px' : compact ? '16px' : '30px',
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
