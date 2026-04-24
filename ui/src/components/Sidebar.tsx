import React, { useState } from 'react';

interface SidebarProps {
    activeService: string;
    onServiceChange: (service: string) => void;
    onOpenLog?: () => void;
    onRepairEnv?: () => void;
    onOpenModels?: () => void;
    hasMissingDeps?: boolean;
    themeMode?: 'light' | 'dark' | 'gradient';
}

const Sidebar: React.FC<SidebarProps> = ({ activeService, onServiceChange, onOpenLog, onRepairEnv, onOpenModels, hasMissingDeps, themeMode }) => {
    const [isHovered, setIsHovered] = useState(false);
    const isLightMode = themeMode === 'gradient';

    const services = [
        { id: 'home', name: '工作台', icon: '🎬' },
        { id: 'batch', name: '批量处理', icon: '🗂️' },
        { id: 'asr', name: '识别中心', icon: '🎙️' },
        { id: 'tts', name: '配音配置', icon: '🗣️' },
        { id: 'translation', name: '翻译配置', icon: '🌐' },
        { id: 'merge', name: '合成配置', icon: '🎞️' }
    ];

    return (
        <div
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            style={{
                width: '80px',
                height: '100%',
                marginRight: '20px',
                position: 'relative',
                flexShrink: 0,
                overflow: 'visible',
                zIndex: 100
            }}
        >
            <div
                style={{
                    width: isHovered ? '240px' : '80px',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '20px',
                    padding: '20px 0',
                    boxSizing: 'border-box',
                    borderRight: isLightMode ? '1px solid rgba(0,0,0,0.1)' : '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '16px',
                    backdropFilter: 'blur(6px)',
                    backgroundColor: isLightMode ? 'rgba(255, 255, 255, 0.82)' : 'rgba(15, 23, 42, 0.82)',
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    transition: 'width 0.22s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.2s ease, border-color 0.2s ease',
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    contain: 'layout paint',
                    willChange: 'width'
                }}
            >
                <div style={{
                    marginBottom: '10px',
                    borderBottom: isLightMode ? '1px solid rgba(0,0,0,0.1)' : '1px solid rgba(255,255,255,0.1)',
                    paddingBottom: '10px',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    height: '52px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    textAlign: 'center'
                }}>
                    {isHovered ? (
                        <div style={{ animation: 'fadeIn 0.2s' }}>
                            <h2 style={{ margin: 0, fontSize: '1.2em', color: isLightMode ? '#1e293b' : '#fff' }}>功能中心</h2>
                            <p style={{ margin: '5px 0 0 0', fontSize: '0.8em', color: isLightMode ? '#000000' : '#ffffff' }}>VS Master</p>
                        </div>
                    ) : (
                        <h2 style={{ margin: 0, fontSize: '1.8em', color: isLightMode ? '#7c3aed' : '#6366f1', fontWeight: 'bold', animation: 'fadeIn 0.2s' }}>VS</h2>
                    )}
                </div>

                <style>{`
@keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
}

.sidebar-nav-button:hover,
.sidebar-utility-button:hover {
    background: ${isLightMode ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)'};
}
`}</style>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', flex: 1 }}>
                    {services.map((service) => (
                        <button
                            key={service.id}
                            className="sidebar-nav-button"
                            onClick={() => onServiceChange(service.id)}
                            title={!isHovered ? service.name : ''}
                            style={navButtonStyle(activeService === service.id, isLightMode)}
                        >
                            <span style={{ fontSize: '1.5em', marginRight: '15px', flexShrink: 0 }}>
                                {service.icon}
                            </span>
                            <span style={labelStyle(isHovered)}>
                                {service.name}
                            </span>
                        </button>
                    ))}
                </div>

                <div style={{
                    marginTop: 'auto',
                    borderTop: isLightMode ? '1px solid rgba(0,0,0,0.1)' : '1px solid rgba(255,255,255,0.1)',
                    paddingTop: '10px',
                    width: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '5px'
                }}>
                    <button
                        className="sidebar-utility-button"
                        onClick={onOpenModels}
                        title={!isHovered ? '模型管理中心' : ''}
                        style={utilityButtonStyle(activeService === 'models', isLightMode)}
                    >
                        <span style={{ fontSize: '1.5em', marginRight: '15px', flexShrink: 0 }}>📦</span>
                        <span style={labelStyle(isHovered)}>模型管理中心</span>
                    </button>

                    <button
                        className="sidebar-utility-button"
                        onClick={onRepairEnv}
                        title={!isHovered ? '修复运行环境' : ''}
                        style={utilityButtonStyle(false, isLightMode)}
                    >
                        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                            <span style={{ fontSize: '1.5em', marginRight: '15px', flexShrink: 0 }}>🧰</span>
                            {hasMissingDeps && (
                                <span style={{
                                    position: 'absolute',
                                    top: '-2px',
                                    right: '12px',
                                    width: '8px',
                                    height: '8px',
                                    borderRadius: '50%',
                                    backgroundColor: '#ef4444',
                                    border: `2px solid ${isLightMode ? '#ffffff' : '#1e293b'}`
                                }} />
                            )}
                        </div>
                        <span style={labelStyle(isHovered)}>修复运行环境</span>
                    </button>

                    <button
                        className="sidebar-utility-button"
                        onClick={onOpenLog}
                        title={!isHovered ? '查看运行日志' : ''}
                        style={utilityButtonStyle(false, isLightMode)}
                    >
                        <span style={{ fontSize: '1.5em', marginRight: '15px', flexShrink: 0 }}>🧾</span>
                        <span style={labelStyle(isHovered)}>查看运行日志</span>
                    </button>

                    <button
                        className="sidebar-utility-button"
                        onClick={() => onServiceChange('about')}
                        title={!isHovered ? '关于' : ''}
                        style={utilityButtonStyle(activeService === 'about', isLightMode)}
                    >
                        <span style={{ fontSize: '1.5em', marginRight: '15px', flexShrink: 0 }}>ℹ️</span>
                        <span style={labelStyle(isHovered)}>关于</span>
                    </button>
                </div>
            </div>
        </div>
    );
};

function navButtonStyle(active: boolean, isLightMode: boolean): React.CSSProperties {
    return {
        display: 'flex',
        alignItems: 'center',
        paddingLeft: '24px',
        paddingRight: '12px',
        paddingTop: '12px',
        paddingBottom: '12px',
        border: 'none',
        borderLeft: active ? '4px solid var(--accent-color)' : '4px solid transparent',
        background: active ? 'linear-gradient(90deg, rgba(99, 102, 241, 0.2), transparent)' : 'transparent',
        color: active ? (isLightMode ? '#7c3aed' : '#fff') : (isLightMode ? '#475569' : '#cbd5e1'),
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background-color 0.18s ease, color 0.18s ease, border-color 0.18s ease',
        outline: 'none',
        fontSize: '0.95em',
        width: '100%',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        position: 'relative'
    };
}

function utilityButtonStyle(active: boolean, isLightMode: boolean): React.CSSProperties {
    return {
        display: 'flex',
        alignItems: 'center',
        paddingLeft: '24px',
        paddingRight: '12px',
        paddingTop: '12px',
        paddingBottom: '12px',
        border: 'none',
        borderLeft: active ? '4px solid var(--accent-color)' : '4px solid transparent',
        background: active ? 'linear-gradient(90deg, rgba(99, 102, 241, 0.2), transparent)' : 'transparent',
        color: active ? (isLightMode ? '#7c3aed' : '#fff') : (isLightMode ? '#64748b' : '#94a3b8'),
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background-color 0.18s ease, color 0.18s ease, border-color 0.18s ease',
        outline: 'none',
        fontSize: '0.95em',
        width: '100%',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        position: 'relative'
    };
}

function labelStyle(isHovered: boolean): React.CSSProperties {
    return {
        opacity: isHovered ? 1 : 0,
        maxWidth: isHovered ? '140px' : '0px',
        marginLeft: '12px',
        overflow: 'hidden',
        transition: 'opacity 0.16s ease, max-width 0.16s ease',
        transitionDelay: isHovered ? '0.1s' : '0s'
    };
}

export default Sidebar;
