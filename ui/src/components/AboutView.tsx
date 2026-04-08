import React from 'react';
import wxImg from '../../wx.jpg';
import zfbImg from '../../zfb.jpg';

interface AboutViewProps {
    themeMode?: 'light' | 'dark' | 'gradient';
}

const AboutView: React.FC<AboutViewProps> = ({ themeMode }) => {
    const isLightMode = themeMode === 'gradient' || themeMode === 'light';

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
                        VideoSyncMaster 是一款强大的视频同步与翻译工具，旨在帮助用户高效地完成视频字幕提取、翻译以及多语言配音工作。
                    </p>
                </div>

                <div style={{ marginBottom: '40px' }}>
                    <h3 style={{ marginBottom: '20px', color: isLightMode ? '#1e293b' : '#fff' }}>赞助与支持</h3>
                    <p style={{ marginBottom: '25px', color: isLightMode ? '#64748b' : '#94a3b8', fontSize: '0.95em' }}>
                        如果您觉得这个工具有所帮助，欢迎通过微信或支付宝进行小额赞助，您的支持是我持续更新的动力。
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

export default AboutView;
