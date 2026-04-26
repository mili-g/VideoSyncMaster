import React, { useState, useEffect } from 'react';
import ConfirmDialog from './ConfirmDialog';

const TranslationConfig: React.FC = () => {
    const [baseUrl, setBaseUrl] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [model, setModel] = useState('');
    const [isLightMode, setIsLightMode] = useState(false);

    // Dialog States
    const [showSaveConfirm, setShowSaveConfirm] = useState(false);
    const [showClearConfirm, setShowClearConfirm] = useState(false);

    useEffect(() => {
        // Load settings
        setBaseUrl(localStorage.getItem('trans_api_base_url') || 'https://api.openai.com/v1/chat/completions');
        setApiKey(localStorage.getItem('trans_api_key') || '');
        setModel(localStorage.getItem('trans_api_model') || 'gpt-3.5-turbo');

        // Check Theme
        const checkTheme = () => {
            setIsLightMode(document.body.classList.contains('light-mode'));
        };
        checkTheme();
        const observer = new MutationObserver(checkTheme);
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    const handleSave = () => {
        localStorage.setItem('trans_api_base_url', baseUrl.trim());
        localStorage.setItem('trans_api_key', apiKey.trim());
        localStorage.setItem('trans_api_model', model.trim());
        setShowSaveConfirm(true);
    };

    const handleClearRequest = () => {
        setShowClearConfirm(true);
    };

    const confirmClear = () => {
        localStorage.removeItem('trans_api_base_url');
        localStorage.removeItem('trans_api_key');
        localStorage.removeItem('trans_api_model');
        setBaseUrl('https://api.openai.com/v1/chat/completions');
        setApiKey('');
        setModel('gpt-3.5-turbo');
        setShowClearConfirm(false);
    };

    const inputStyle = {
        width: '100%',
        padding: '12px',
        background: isLightMode ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.3)',
        border: '1px solid var(--border-color)',
        borderRadius: '8px',
        color: 'inherit',
        fontSize: '1em',
        outline: 'none',
        transition: 'border-color 0.3s'
    };

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
            <div style={{ width: '100%', maxWidth: '800px' }}>
                <h2 style={{
                    color: 'var(--text-primary)',
                    marginBottom: '30px',
                    borderBottom: '1px solid var(--border-color)',
                    paddingBottom: '15px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px'
                }}>
                    🌐 翻译 API 配置 (Translation API)
                </h2>

                <div style={{
                    background: isLightMode ? 'rgba(59, 130, 246, 0.1)' : 'rgba(59, 130, 246, 0.15)',
                    borderLeft: '4px solid #3b82f6',
                    padding: '20px',
                    borderRadius: '8px',
                    marginBottom: '30px'
                }}>
                    <p style={{ margin: 0, fontSize: '0.95em', lineHeight: '1.6', color: 'var(--text-primary)' }}>
                        配置 OpenAI 兼容翻译接口用于翻译。请填写完整请求地址。<br />
                        <strong>注意：</strong><br />
                        1. 填写 API Key 后，系统将优先使用此 API。<br />
                        2. 遇到 API 错误时将直接报错，不会回退到本地模型。<br />
                        3. 这里不会自动拼接路径，请直接填写完整端点，如 <code>/chat/completions</code>。<br />
                        4. 如需使用本地 Qwen 模型，请清空配置。
                    </p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '25px' }}>

                    {/* Base URL */}
                    <div>
                        <label style={{ display: 'block', marginBottom: '10px', fontWeight: 'bold', color: 'var(--text-primary)' }}>
                            API Base URL (接口地址)
                        </label>
                        <input
                            type="text"
                            value={baseUrl}
                            onChange={(e) => setBaseUrl(e.target.value)}
                            placeholder="e.g. https://api.openai.com/v1/chat/completions"
                            style={inputStyle}
                        />
                        <div style={{ fontSize: '0.85em', color: 'var(--text-secondary)', marginTop: '8px', marginLeft: '5px' }}>
                            常见示例: <code>https://api.openai.com/v1/chat/completions</code> 或 <code>https://api.deepseek.com/chat/completions</code>
                        </div>
                    </div>

                    {/* API Key */}
                    <div>
                        <label style={{ display: 'block', marginBottom: '10px', fontWeight: 'bold', color: 'var(--text-primary)' }}>
                            API Key (密钥)
                        </label>
                        <input
                            type="password"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder="sk-..."
                            style={inputStyle}
                        />
                    </div>

                    {/* Model */}
                    <div>
                        <label style={{ display: 'block', marginBottom: '10px', fontWeight: 'bold', color: 'var(--text-primary)' }}>
                            Model Name (模型名称)
                        </label>
                        <input
                            type="text"
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                            placeholder="e.g. gpt-4o, deepseek-chat"
                            style={inputStyle}
                        />
                    </div>

                    <div style={{ display: 'flex', gap: '20px', marginTop: '30px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
                        <button
                            onClick={handleSave}
                            className="btn"
                            style={{
                                padding: '12px 30px',
                                background: '#3b82f6',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '8px',
                                cursor: 'pointer',
                                fontSize: '1.1em',
                                flex: 2,
                                display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '10px'
                            }}
                        >
                            <span>💾</span> 保存配置 (Save)
                        </button>

                        <button
                            onClick={handleClearRequest}
                            className="btn"
                            style={{
                                padding: '12px 20px',
                                background: 'transparent',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-color)',
                                borderRadius: '8px',
                                cursor: 'pointer',
                                fontSize: '1em',
                                flex: 1
                            }}
                        >
                            🗑️ 恢复默认 (Clear)
                        </button>
                    </div>

                </div>
            </div>

            {/* Confirm Dialogs */}
            <ConfirmDialog
                isOpen={showSaveConfirm}
                title="保存成功"
                message="API 配置已更新并保存到本地。"
                onConfirm={() => setShowSaveConfirm(false)}
                isLightMode={isLightMode}
                confirmText="确定"
                cancelText="" // Hide cancel
                confirmColor="#10b981"
            />

            <ConfirmDialog
                isOpen={showClearConfirm}
                title="确认清除"
                message="确定要清除 API 配置并恢复默认（使用本地模型）吗？"
                onConfirm={confirmClear}
                onCancel={() => setShowClearConfirm(false)}
                isLightMode={isLightMode}
                confirmText="清除并恢复"
                cancelText="取消"
                confirmColor="#ef4444"
            />
        </div>
    );
};

export default TranslationConfig;
