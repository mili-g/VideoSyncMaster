import React from 'react';
import { BACKEND_COMMAND_CATALOG } from '../types/backendCommandCatalog';

interface AboutViewProps {
    themeMode?: 'light' | 'dark' | 'gradient';
}

const AboutView: React.FC<AboutViewProps> = ({ themeMode }) => {
    const isLightMode = themeMode === 'gradient' || themeMode === 'light';
    const commandGroups = Array.from(
        BACKEND_COMMAND_CATALOG.commands.reduce((map, command) => {
            const existing = map.get(command.category) || [];
            existing.push(command);
            map.set(command.category, existing);
            return map;
        }, new Map<string, typeof BACKEND_COMMAND_CATALOG.commands>())
    );

    return (
        <div className="glass-panel" style={{
            height: '100%',
            overflowY: 'auto',
            padding: '40px',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center'
        }}>
            <div style={{ width: '100%', maxWidth: '700px', textAlign: 'center' }}>
                <h1 style={{ marginBottom: '20px', fontSize: '2.5em', color: isLightMode ? '#1e293b' : '#fff' }}>
                    关于
                </h1>

                <div style={{
                    background: isLightMode ? 'rgba(99, 102, 241, 0.1)' : 'linear-gradient(180deg, rgba(59,130,246,0.16), rgba(30,41,59,0.3))',
                    padding: '32px',
                    borderRadius: '18px',
                    marginBottom: '40px',
                    border: '1px solid rgba(99, 102, 241, 0.22)',
                    boxShadow: isLightMode ? '0 18px 40px rgba(15,23,42,0.08)' : '0 20px 44px rgba(2,6,23,0.22)'
                }}>
                    <div style={{ marginBottom: '18px' }}>
                        <p style={{ fontSize: '0.82em', letterSpacing: '0.08em', textTransform: 'uppercase', color: isLightMode ? '#475569' : '#93c5fd', margin: '0 0 10px 0' }}>
                            Product Overview
                        </p>
                        <p style={{ fontSize: '1.36em', fontWeight: 800, margin: 0 }}>VideoSyncMaster</p>
                    </div>
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                        gap: '12px',
                        marginBottom: '22px',
                        textAlign: 'left'
                    }}>
                        <div style={heroMetricStyle(isLightMode)}>
                            <div style={heroMetricLabelStyle(isLightMode)}>版本</div>
                            <div style={heroMetricValueStyle(isLightMode)}>v1.0.0</div>
                        </div>
                        <div style={heroMetricStyle(isLightMode)}>
                            <div style={heroMetricLabelStyle(isLightMode)}>著作权署名</div>
                            <div style={heroMetricValueStyle(isLightMode)}>RRQ-DS</div>
                        </div>
                        <div style={heroMetricStyle(isLightMode)}>
                            <div style={heroMetricLabelStyle(isLightMode)}>定位</div>
                            <div style={heroMetricValueStyle(isLightMode)}>商业版本</div>
                        </div>
                    </div>
                </div>

                <div style={{
                    textAlign: 'left',
                    background: isLightMode ? 'rgba(15, 23, 42, 0.04)' : 'rgba(15, 23, 42, 0.22)',
                    padding: '24px',
                    borderRadius: '18px',
                    marginBottom: '40px',
                    border: '1px solid var(--border-color)'
                }}>
                    <div style={{ marginBottom: '18px' }}>
                        <h3 style={{ margin: '0 0 8px 0', color: isLightMode ? '#1e293b' : '#fff' }}>后端命令目录</h3>
                    </div>

                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                        gap: '12px',
                        marginBottom: '20px'
                    }}>
                        <div style={infoBlockStyle(isLightMode)}>
                            <div style={infoLabelStyle(isLightMode)}>Catalog 版本</div>
                            <div style={infoValueStyle(isLightMode)}>{BACKEND_COMMAND_CATALOG.version}</div>
                        </div>
                        <div style={infoBlockStyle(isLightMode)}>
                            <div style={infoLabelStyle(isLightMode)}>命令数量</div>
                            <div style={infoValueStyle(isLightMode)}>{BACKEND_COMMAND_CATALOG.commands.length}</div>
                        </div>
                        <div style={infoBlockStyle(isLightMode)}>
                            <div style={infoLabelStyle(isLightMode)}>分类数量</div>
                            <div style={infoValueStyle(isLightMode)}>{commandGroups.length}</div>
                        </div>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                        {commandGroups.map(([category, commands]) => (
                            <details
                                key={category}
                                style={{
                                    background: isLightMode ? 'rgba(255,255,255,0.75)' : 'rgba(15,23,42,0.28)',
                                    border: '1px solid var(--border-color)',
                                    borderRadius: '12px',
                                    padding: '14px 16px'
                                }}
                            >
                                <summary style={{
                                    cursor: 'pointer',
                                    listStyle: 'none',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: '12px',
                                    fontWeight: 600,
                                    color: isLightMode ? '#0f172a' : '#e2e8f0'
                                }}>
                                    <span>{category}</span>
                                    <span style={{
                                        fontSize: '0.85em',
                                        color: isLightMode ? '#64748b' : '#94a3b8'
                                    }}>
                                        {commands.length} 个命令
                                    </span>
                                </summary>

                                <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                    {commands.map((command) => (
                                        <div
                                            key={command.name}
                                            style={{
                                                padding: '12px 14px',
                                                borderRadius: '10px',
                                                background: isLightMode ? 'rgba(99, 102, 241, 0.06)' : 'rgba(30, 41, 59, 0.55)',
                                                border: '1px solid rgba(99, 102, 241, 0.12)'
                                            }}
                                        >
                                            <div style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                gap: '12px',
                                                marginBottom: '6px'
                                            }}>
                                                <code style={{
                                                    fontSize: '0.95em',
                                                    color: isLightMode ? '#312e81' : '#c4b5fd',
                                                    wordBreak: 'break-all'
                                                }}>
                                                    {command.name}
                                                </code>
                                                <span style={{
                                                    fontSize: '0.8em',
                                                    color: isLightMode ? '#64748b' : '#94a3b8',
                                                    whiteSpace: 'nowrap'
                                                }}>
                                                    JSON: {command.json_supported ? 'Yes' : 'No'}
                                                </span>
                                            </div>
                                            <div style={{
                                                fontSize: '0.92em',
                                                lineHeight: 1.6,
                                                color: isLightMode ? '#475569' : '#cbd5e1',
                                                marginBottom: command.args.length > 0 ? '8px' : 0
                                            }}>
                                                {command.description}
                                            </div>
                                            {command.args.length > 0 && (
                                                <div style={{
                                                    display: 'flex',
                                                    flexWrap: 'wrap',
                                                    gap: '8px'
                                                }}>
                                                    {command.args.map((arg) => (
                                                        <span
                                                            key={`${command.name}-${arg.name}`}
                                                            style={{
                                                                display: 'inline-flex',
                                                                alignItems: 'center',
                                                                gap: '6px',
                                                                padding: '4px 8px',
                                                                borderRadius: '999px',
                                                                fontSize: '0.8em',
                                                                background: isLightMode ? 'rgba(15, 23, 42, 0.06)' : 'rgba(148, 163, 184, 0.12)',
                                                                color: isLightMode ? '#334155' : '#cbd5e1'
                                                            }}
                                                            title={arg.description}
                                                        >
                                                            <code>{arg.name}</code>
                                                            <span>{arg.required ? 'required' : 'optional'}</span>
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </details>
                        ))}
                    </div>
                </div>

                <div style={{ marginBottom: '40px' }}>
                    <h3 style={{ marginBottom: '20px', color: isLightMode ? '#1e293b' : '#fff' }}>商务与支持</h3>

                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                        gap: '16px',
                        textAlign: 'left'
                    }}>
                        <div style={contactCardStyle(isLightMode)}>
                            <div style={contactEyebrowStyle(isLightMode)}>Primary Contact</div>
                            <div style={contactTitleStyle(isLightMode)}>商务邮箱</div>
                            <a
                                href="mailto:1556049389@qq.com"
                                style={{
                                    display: 'inline-block',
                                    marginTop: '10px',
                                    fontSize: '1.02em',
                                    fontWeight: 700,
                                    color: isLightMode ? '#1d4ed8' : '#93c5fd',
                                    textDecoration: 'none',
                                    wordBreak: 'break-all'
                                }}
                            >
                                1556049389@qq.com
                            </a>
                        </div>

                        <div style={contactCardStyle(isLightMode)}>
                            <div style={contactEyebrowStyle(isLightMode)}>Service Scope</div>
                            <div style={contactTitleStyle(isLightMode)}>交付范围</div>
                            <div style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: '8px',
                                marginTop: '12px',
                                marginBottom: '10px'
                            }}>
                                {['字幕生产', '配音合成', '批量交付', '流程定制'].map((item) => (
                                    <span key={item} style={serviceTagStyle(isLightMode)}>
                                        {item}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '20px', fontSize: '0.85em', color: isLightMode ? '#64748b' : '#94a3b8' }}>
                    <p>© 2026 VideoSyncMaster. All rights reserved. Developed and maintained by RRQ-DS.</p>
                </div>
            </div>
        </div>
    );
};

function infoBlockStyle(isLightMode: boolean): React.CSSProperties {
    return {
        padding: '14px 16px',
        borderRadius: '12px',
        border: '1px solid var(--border-color)',
        background: isLightMode ? 'rgba(255,255,255,0.8)' : 'rgba(30,41,59,0.45)'
    };
}

function infoLabelStyle(isLightMode: boolean): React.CSSProperties {
    return {
        fontSize: '0.82em',
        color: isLightMode ? '#64748b' : '#94a3b8',
        marginBottom: '6px'
    };
}

function infoValueStyle(isLightMode: boolean): React.CSSProperties {
    return {
        fontSize: '1.15em',
        fontWeight: 700,
        color: isLightMode ? '#0f172a' : '#f8fafc'
    };
}

function heroMetricStyle(isLightMode: boolean): React.CSSProperties {
    return {
        padding: '14px 16px',
        borderRadius: '12px',
        background: isLightMode ? 'rgba(255,255,255,0.78)' : 'rgba(15,23,42,0.36)',
        border: '1px solid rgba(148, 163, 184, 0.18)'
    };
}

function heroMetricLabelStyle(isLightMode: boolean): React.CSSProperties {
    return {
        fontSize: '0.8em',
        marginBottom: '6px',
        color: isLightMode ? '#64748b' : '#93c5fd'
    };
}

function heroMetricValueStyle(isLightMode: boolean): React.CSSProperties {
    return {
        fontSize: '1.04em',
        fontWeight: 700,
        color: isLightMode ? '#0f172a' : '#f8fafc'
    };
}

function contactCardStyle(isLightMode: boolean): React.CSSProperties {
    return {
        padding: '20px',
        borderRadius: '16px',
        background: isLightMode ? 'rgba(255,255,255,0.82)' : 'rgba(15,23,42,0.3)',
        border: '1px solid rgba(148, 163, 184, 0.18)',
        boxShadow: isLightMode ? '0 14px 32px rgba(15,23,42,0.06)' : '0 14px 32px rgba(2,6,23,0.16)'
    };
}

function contactEyebrowStyle(isLightMode: boolean): React.CSSProperties {
    return {
        fontSize: '0.78em',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: isLightMode ? '#64748b' : '#93c5fd',
        marginBottom: '8px'
    };
}

function contactTitleStyle(isLightMode: boolean): React.CSSProperties {
    return {
        fontSize: '1.08em',
        fontWeight: 700,
        color: isLightMode ? '#0f172a' : '#f8fafc'
    };
}

function serviceTagStyle(isLightMode: boolean): React.CSSProperties {
    return {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '5px 10px',
        borderRadius: '999px',
        fontSize: '0.8em',
        background: isLightMode ? 'rgba(37, 99, 235, 0.08)' : 'rgba(59,130,246,0.16)',
        color: isLightMode ? '#1d4ed8' : '#bfdbfe',
        border: '1px solid rgba(59,130,246,0.16)'
    };
}

export default AboutView;
