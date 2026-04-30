import React, { useEffect, useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { FieldBlock } from '../features/asr/shared';

const DEFAULT_TRANSLATION_URL = 'https://api.openai.com/v1/chat/completions';

const TranslationConfig: React.FC = () => {
    const [baseUrl, setBaseUrl] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [model, setModel] = useState('');
    const [isLightMode, setIsLightMode] = useState(false);
    const [showSaveConfirm, setShowSaveConfirm] = useState(false);
    const [showClearConfirm, setShowClearConfirm] = useState(false);

    useEffect(() => {
        setBaseUrl(localStorage.getItem('trans_api_base_url') || DEFAULT_TRANSLATION_URL);
        setApiKey(localStorage.getItem('trans_api_key') || '');
        setModel(localStorage.getItem('trans_api_model') || '');

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

    const confirmClear = () => {
        localStorage.removeItem('trans_api_base_url');
        localStorage.removeItem('trans_api_key');
        localStorage.removeItem('trans_api_model');
        setBaseUrl(DEFAULT_TRANSLATION_URL);
        setApiKey('');
        setModel('');
        setShowClearConfirm(false);
    };

    return (
        <div className="tool-panel">
            <section className="config-section">
                <div className="tool-toolbar">
                    <div className="tool-toolbar__title">
                        <h3>翻译接口</h3>
                        <p>配置兼容 OpenAI 协议的翻译接口，用于接管字幕翻译任务。</p>
                    </div>
                    <div className="status-inline">
                        {apiKey ? '外部接口' : '本地链路'}
                    </div>
                </div>

                <div className="tool-banner">
                    <div className="tool-banner__title">接口规则</div>
                    <div className="tool-banner__body">
                        请填写完整接口地址。配置 API Key 后，翻译任务将优先使用该接口。
                    </div>
                </div>

                <div className="dense-grid dense-grid--single">
                    <FieldBlock
                        label="接口地址"
                        hint="示例：https://api.openai.com/v1/chat/completions"
                    >
                        <input
                            className="field-control"
                            type="text"
                            value={baseUrl}
                            onChange={(event) => setBaseUrl(event.target.value)}
                            placeholder={DEFAULT_TRANSLATION_URL}
                        />
                    </FieldBlock>

                    <FieldBlock
                        label="API Key"
                        hint="留空时使用本地翻译链路。"
                    >
                        <input
                            className="field-control"
                            type="password"
                            value={apiKey}
                            onChange={(event) => setApiKey(event.target.value)}
                            placeholder="sk-..."
                        />
                    </FieldBlock>

                    <FieldBlock
                        label="模型名"
                        hint="示例：gpt-4.1-mini、deepseek-chat"
                    >
                        <input
                            className="field-control"
                            type="text"
                            value={model}
                            onChange={(event) => setModel(event.target.value)}
                            placeholder="gpt-4.1-mini"
                        />
                    </FieldBlock>
                </div>

                <div className="form-actions">
                    <button type="button" className="secondary-button secondary-button--danger" onClick={() => setShowClearConfirm(true)}>
                        清空配置
                    </button>
                    <button type="button" className="primary-button" onClick={handleSave}>
                        保存配置
                    </button>
                </div>
            </section>

            <ConfirmDialog
                isOpen={showSaveConfirm}
                title="保存成功"
                message="翻译接口配置已更新。"
                onConfirm={() => setShowSaveConfirm(false)}
                isLightMode={isLightMode}
                confirmText="确定"
                cancelText=""
                confirmColor="#10b981"
            />

            <ConfirmDialog
                isOpen={showClearConfirm}
                title="确认清除"
                message="确定清空当前接口配置并切回本地翻译链路吗？"
                onConfirm={confirmClear}
                onCancel={() => setShowClearConfirm(false)}
                isLightMode={isLightMode}
                confirmText="确认清空"
                cancelText="取消"
                confirmColor="#ef4444"
            />
        </div>
    );
};

export default TranslationConfig;
