import React from 'react';
import wxImg from '../../wx.jpg';
import zfbImg from '../../zfb.jpg';
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
                    background: isLightMode ? 'rgba(99, 102, 241, 0.1)' : 'rgba(99, 102, 241, 0.15)',
                    padding: '30px',
                    borderRadius: '20px',
                    marginBottom: '40px',
                    border: '1px solid rgba(99, 102, 241, 0.2)'
                }}>
                    <p style={{ fontSize: '1.2em', fontWeight: 'bold', margin: '0 0 10px 0' }}>VideoSyncMaster</p>
                    <p style={{ fontSize: '0.9em', color: isLightMode ? '#64748b' : '#94a3b8', margin: '0 0 20px 0' }}>
                        Version: v1.0.0
                    </p>
                    <p style={{ lineHeight: '1.6', margin: 0 }}>
                        VideoSyncMaster 面向字幕生产、多语言配音与成片交付场景，提供统一的视频本地化工作流。
                    </p>
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
                        <p style={{ margin: 0, color: isLightMode ? '#64748b' : '#94a3b8', fontSize: '0.95em', lineHeight: 1.6 }}>
                            当前版本内置 {BACKEND_COMMAND_CATALOG.commands.length} 个后端动作，用于支撑识别、翻译、配音与合成流程。
                            该目录可用于版本核验、能力巡检与执行链路确认。
                        </p>
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
                    <p style={{ marginBottom: '25px', color: isLightMode ? '#64748b' : '#94a3b8', fontSize: '0.95em' }}>
                        如需商务合作、功能定制或持续支持，可通过以下方式与项目维护方联系。
                    </p>

                    <div style={{ display: 'flex', justifyContent: 'center', gap: '40px', flexWrap: 'wrap' }}>
                        <div style={{ textAlign: 'center' }}>
                            <div style={{
                                width: '200px',
                                height: '200px',
                                background: '#fff',
                                padding: '10px',
                                borderRadius: '12px',
                                boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
                                marginBottom: '10px'
                            }}>
                                <img src={wxImg} alt="WeChat Pay" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                            </div>
                            <p style={{ fontWeight: 'bold', color: '#07c160' }}>微信支付</p>
                        </div>

                        <div style={{ textAlign: 'center' }}>
                            <div style={{
                                width: '200px',
                                height: '200px',
                                background: '#fff',
                                padding: '10px',
                                borderRadius: '12px',
                                boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
                                marginBottom: '10px'
                            }}>
                                <img src={zfbImg} alt="Alipay" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                            </div>
                            <p style={{ fontWeight: 'bold', color: '#1677ff' }}>支付宝支付</p>
                        </div>
                    </div>
                </div>

                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '20px', fontSize: '0.85em', color: isLightMode ? '#64748b' : '#94a3b8' }}>
                    <p>© 2026 VideoSyncMaster. Developed by 天冬 (TianDong) - Batch Features and Optimization by RRQ-DS</p>
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

export default AboutView;
