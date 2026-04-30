import React from 'react';

interface ConfirmDialogProps {
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    onCancel?: () => void;
    isLightMode?: boolean;
    confirmText?: string;
    cancelText?: string;
    confirmColor?: string;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
    isOpen,
    title,
    message,
    onConfirm,
    onCancel,
    isLightMode,
    confirmText = '确定',
    cancelText = '取消',
    confirmColor = '#3b82f6' // Default Blue
}) => {
    if (!isOpen) return null;

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            backdropFilter: 'blur(4px)'
        }}>
            <div className="glass-panel" style={{
                minWidth: '320px',
                maxWidth: '90%',
                padding: '24px',
                background: isLightMode ? 'rgba(255,255,255,0.95)' : 'rgba(30, 41, 59, 0.95)',
                border: '1px solid ' + (isLightMode ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)'),
                boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2), 0 10px 10px -5px rgba(0, 0, 0, 0.1)',
                animation: 'fadeIn 0.2s ease-out'
            }}>
                <h3 style={{
                    marginTop: 0,
                    marginBottom: '12px',
                    fontSize: '1.25rem',
                    color: isLightMode ? '#1e293b' : '#f8fafc',
                    fontWeight: 600
                }}>
                    {title}
                </h3>
                <p style={{
                    color: isLightMode ? '#475569' : '#94a3b8',
                    marginBottom: '24px',
                    lineHeight: 1.6
                }}>
                    {message}
                </p>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                    {onCancel && (
                        <button
                            onClick={onCancel}
                            style={{
                                padding: '8px 20px',
                                borderRadius: '8px',
                                border: `1px solid ${isLightMode ? '#e2e8f0' : '#475569'}`,
                                background: 'transparent',
                                color: isLightMode ? '#475569' : '#cbd5e1',
                                cursor: 'pointer',
                                fontWeight: 500,
                                transition: 'all 0.2s'
                            }}
                            onMouseOver={(e) => e.currentTarget.style.background = isLightMode ? '#f1f5f9' : 'rgba(255,255,255,0.05)'}
                            onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                            {cancelText}
                        </button>
                    )}
                    <button
                        onClick={onConfirm}
                        style={{
                            padding: '8px 20px',
                            borderRadius: '8px',
                            border: 'none',
                            background: confirmColor,
                            color: 'white',
                            cursor: 'pointer',
                            fontWeight: 600,
                            boxShadow: `0 4px 6px -1px ${confirmColor}40`,
                            transition: 'all 0.2s'
                        }}
                        onMouseOver={(e) => {
                            e.currentTarget.style.transform = 'translateY(-1px)';
                            e.currentTarget.style.boxShadow = `0 6px 8px -1px ${confirmColor}60`;
                        }}
                        onMouseOut={(e) => {
                            e.currentTarget.style.transform = 'none';
                            e.currentTarget.style.boxShadow = `0 4px 6px -1px ${confirmColor}40`;
                        }}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
            <style>{`
                @keyframes fadeIn {
                    from { opacity: 0; transform: scale(0.95); }
                    to { opacity: 1; transform: scale(1); }
                }
            `}</style>
        </div>
    );
};

export default ConfirmDialog;
