import { useEffect, useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { preparePreviewCacheFile } from '../utils/projectPaths';
import { buildTestTtsCommand } from '../utils/backendCommandBuilders';
import { runBackendCommand } from '../utils/backendCommandClient';
import type { TtsVoiceMode } from '../utils/runtimeSettings';
import { TTS_MODEL_PROFILES } from '../utils/modelProfiles';
import { FieldBlock } from '../features/asr/shared';

interface QwenTTSConfigProps {
    themeMode?: 'light' | 'dark' | 'gradient';
    voiceMode: TtsVoiceMode;
    isActive?: boolean;
    modelProfile: string;
    onModelProfileChange?: (profileId: string) => void;
    onActivate?: () => void;
    onModeChange?: (mode: 'clone' | 'design' | 'preset') => void;
    batchSize: number;
    setBatchSize: (size: number) => void;
    cloneBatchSize: number;
    setCloneBatchSize: (size: number) => void;
    maxNewTokens: number;
    setMaxNewTokens: (token: number) => void;
}

type QwenMode = 'clone' | 'design' | 'preset';

const PRESET_VOICE_OPTIONS = [
    { value: 'Vivian', label: 'Vivian - 推荐中文' },
    { value: 'Serena', label: 'Serena - 推荐中文' },
    { value: 'Uncle_Fu', label: 'Uncle_Fu - 傅大爷，推荐中文' },
    { value: 'Dylan', label: 'Dylan - 推荐英文' },
    { value: 'Eric', label: 'Eric - 推荐英文' },
    { value: 'Ryan', label: 'Ryan - 推荐英文' },
    { value: 'Aiden', label: 'Aiden - 推荐英文' },
    { value: 'Ono_Anna', label: 'Ono_Anna - 推荐日文' },
    { value: 'Sohee', label: 'Sohee - 推荐韩文' }
] as const;

const LANGUAGE_OPTIONS = [
    { value: 'Chinese', label: 'Chinese - 中文' },
    { value: 'English', label: 'English - 英文' },
    { value: 'Japanese', label: 'Japanese - 日文' },
    { value: 'Korean', label: 'Korean - 韩文' },
    { value: 'German', label: 'German - 德文' },
    { value: 'French', label: 'French - 法文' },
    { value: 'Spanish', label: 'Spanish - 西班牙文' },
    { value: 'Russian', label: 'Russian - 俄文' },
    { value: 'Portuguese', label: 'Portuguese - 葡萄牙文' },
    { value: 'Italian', label: 'Italian - 意大利文' }
] as const;

const MODE_META: Record<QwenMode, { title: string; summary: string }> = {
    clone: {
        title: '声音克隆',
        summary: '基于参考音频还原说话人音色特征。'
    },
    design: {
        title: '声音设计',
        summary: '通过文本定义目标音色，并用于整片配音。'
    },
    preset: {
        title: '预置音色',
        summary: '调用内置音色。'
    }
};

const MODE_PREVIEW_HINT: Record<QwenMode, string> = {
    clone: '试听前请先提供参考音频。',
    design: '请先确认设计音色。',
    preset: '请先确认预置音色表现。'
};

function QwenTTSConfig({
    themeMode,
    voiceMode,
    isActive,
    modelProfile,
    onModelProfileChange,
    onActivate,
    onModeChange,
    batchSize,
    setBatchSize,
    cloneBatchSize,
    setCloneBatchSize,
    maxNewTokens,
    setMaxNewTokens
}: QwenTTSConfigProps) {
    const isLightMode = themeMode === 'gradient' || themeMode === 'light';
    const isNarrationMode = voiceMode === 'narration';

    const [mode, setMode] = useState<QwenMode>('clone');
    const [activeMode, setActiveMode] = useState<QwenMode | null>(null);
    const [refAudioPath, setRefAudioPath] = useState('');
    const [voiceInstruction, setVoiceInstruction] = useState('');
    const [presetVoice, setPresetVoice] = useState('Vivian');
    const [refText, setRefText] = useState('');
    const [language, setLanguage] = useState('Chinese');
    const [previewTexts, setPreviewTexts] = useState<Record<QwenMode, string>>({
        clone: '这是一个声音克隆的测试音频。',
        design: '这是一个声音设计的测试音频。',
        preset: '这是一个预置音色的测试音频。'
    });
    const [feedback, setFeedback] = useState<{ title: string; message: string; type: 'success' | 'error' } | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [generatedPaths, setGeneratedPaths] = useState<Record<QwenMode, string | null>>({
        clone: null,
        design: null,
        preset: null
    });
    const [isPlaying, setIsPlaying] = useState(false);
    const [audioObj, setAudioObj] = useState<HTMLAudioElement | null>(null);
    const [hasDesignRef, setHasDesignRef] = useState(false);

    const currentConcurrency = isNarrationMode || mode !== 'clone' ? batchSize : cloneBatchSize;
    const setCurrentConcurrency = isNarrationMode || mode !== 'clone' ? setBatchSize : setCloneBatchSize;
    const currentPreviewPath = generatedPaths[mode];
    const currentPreviewText = previewTexts[mode];

    const runtimeSummary = isNarrationMode
        ? '朗读模式使用统一声音来源。'
        : '克隆模式保留原片语气特征。';

    const modeCombinationHint = mode === 'clone'
        ? (isNarrationMode
            ? '未指定参考音时，将在正式生成时提取统一参考音。'
            : '未指定参考音时，将结合原片逐句特征生成。')
        : mode === 'design'
            ? '声音设计优先保证整片音色一致性。'
            : '预置音色适用于快速配音。';

    useEffect(() => {
        const storedMode = localStorage.getItem('qwen_mode') as QwenMode | null;
        if (storedMode === 'clone' || storedMode === 'design' || storedMode === 'preset') {
            setMode(storedMode);
            setActiveMode(storedMode);
            onModeChange?.(storedMode);
        }

        const storedRef = localStorage.getItem('qwen_ref_audio_path');
        if (storedRef) setRefAudioPath(storedRef);

        const storedRefText = localStorage.getItem('qwen_ref_text');
        if (storedRefText) setRefText(storedRefText);

        const storedInstruction = localStorage.getItem('qwen_voice_instruction');
        if (storedInstruction) setVoiceInstruction(storedInstruction);

        const storedPreset = localStorage.getItem('qwen_preset_voice');
        if (storedPreset) setPresetVoice(storedPreset);

        const storedLanguage = localStorage.getItem('qwen_language');
        if (storedLanguage && storedLanguage !== 'Auto') {
            setLanguage(storedLanguage);
        } else if (storedLanguage === 'Auto') {
            localStorage.setItem('qwen_language', 'Chinese');
        }

        const previewPathMap: Record<QwenMode, string | null> = {
            clone: localStorage.getItem('qwen_preview_path_clone'),
            design: localStorage.getItem('qwen_preview_path_design'),
            preset: localStorage.getItem('qwen_preview_path_preset')
        };
        const previewTextMap: Record<QwenMode, string> = {
            clone: localStorage.getItem('qwen_preview_text_clone') || '这是一个声音克隆的测试音频。',
            design: localStorage.getItem('qwen_preview_text_design') || '这是一个声音设计的测试音频。',
            preset: localStorage.getItem('qwen_preview_text_preset') || '这是一个预置音色的测试音频。'
        };
        setGeneratedPaths(previewPathMap);
        setPreviewTexts(previewTextMap);
        setHasDesignRef(!!localStorage.getItem('qwen_design_ref_audio'));
    }, [onModeChange]);

    useEffect(() => {
        return () => {
            if (audioObj) {
                audioObj.pause();
                audioObj.currentTime = 0;
            }
        };
    }, [audioObj]);

    const handleModeSwitch = (nextMode: QwenMode) => {
        setMode(nextMode);
        onModeChange?.(nextMode);
    };

    const handleSave = () => {
        localStorage.setItem('qwen_mode', mode);
        localStorage.setItem('qwen_ref_audio_path', refAudioPath);
        localStorage.setItem('qwen_ref_text', refText);
        localStorage.setItem('qwen_voice_instruction', voiceInstruction);
        localStorage.setItem('qwen_preset_voice', presetVoice);
        localStorage.setItem('qwen_language', language);
        setActiveMode(mode);
        setFeedback({ title: '保存成功', message: 'Qwen3-TTS 配置已保存。', type: 'success' });
    };

    const handleGeneratePreview = async () => {
        if (!currentPreviewText.trim()) return;

        if (mode === 'clone' && !refAudioPath) {
            setFeedback({
                title: '缺少参考音频',
                message: isNarrationMode
                    ? '朗读模式试听不会自动截取原片默认参考音，请先上传固定参考音频。'
                    : '克隆模式试听前请先上传参考音频。',
                type: 'error'
            });
            return;
        }

        if (isPlaying && audioObj) {
            audioObj.pause();
            setIsPlaying(false);
        }

        setPreviewLoading(true);
        setGeneratedPaths((prev) => ({ ...prev, [mode]: null }));

        try {
            const { outputPath } = await preparePreviewCacheFile(`preview_qwen_${mode}.wav`);
            const args = buildTestTtsCommand({
                input: currentPreviewText,
                output: outputPath,
                json: true,
                ttsService: 'qwen',
                ttsModelProfile: modelProfile,
                qwenMode: mode,
                language,
                ref: mode === 'clone' && refAudioPath ? refAudioPath : undefined,
                qwenRefText: mode === 'clone' && refText.trim() ? refText.trim() : undefined,
                voiceInstruct: mode === 'design' && voiceInstruction.trim() ? voiceInstruction.trim() : undefined,
                presetVoice: mode === 'preset' ? presetVoice : undefined
            });

            const result = await runBackendCommand(args);
            if (!result?.success) {
                setFeedback({ title: '合成失败', message: result?.error || '未知错误', type: 'error' });
                return;
            }

            setGeneratedPaths((prev) => ({ ...prev, [mode]: outputPath }));
            localStorage.setItem(`qwen_preview_path_${mode}`, outputPath);
            localStorage.setItem(`qwen_preview_text_${mode}`, currentPreviewText);

            if (mode === 'design') {
                localStorage.setItem('qwen_design_ref_audio', outputPath);
                localStorage.setItem('qwen_design_ref_text', currentPreviewText);
                setHasDesignRef(true);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setFeedback({ title: '合成错误', message, type: 'error' });
        } finally {
            setPreviewLoading(false);
        }
    };

    const handlePlayPreview = () => {
        if (!currentPreviewPath) return;

        if (isPlaying && audioObj) {
            audioObj.pause();
            audioObj.currentTime = 0;
            setIsPlaying(false);
            return;
        }

        const audio = new Audio(`file:///${currentPreviewPath.replace(/\\/g, '/')}?t=${Date.now()}`);
        setAudioObj(audio);
        setIsPlaying(true);
        audio.play().catch(() => setIsPlaying(false));
        audio.onended = () => setIsPlaying(false);
    };

    const handleStopPreview = async () => {
        try {
            await window.api.killBackend();
            setPreviewLoading(false);
            setFeedback({ title: '已停止', message: '试听任务已停止。', type: 'error' });
        } catch {
            setFeedback({ title: '停止失败', message: '无法停止试听任务，请检查后台日志。', type: 'error' });
        }
    };

    const handleSelectFile = async () => {
        try {
            const result = await window.api.openFileDialog({
                filters: [{ name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'm4a'] }]
            });
            if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
                setRefAudioPath(result.filePaths[0]);
            }
        } catch {
            setFeedback({ title: '选择失败', message: '无法读取参考音频。', type: 'error' });
        }
    };

    const clearReferenceAudio = () => {
        setRefAudioPath('');
        localStorage.removeItem('qwen_ref_audio_path');
    };

    const handleClearDesign = () => {
        localStorage.removeItem('qwen_design_ref_audio');
        localStorage.removeItem('qwen_design_ref_text');
        localStorage.removeItem('qwen_preview_path_design');
        setHasDesignRef(false);
        setGeneratedPaths((prev) => ({ ...prev, design: null }));
    };

    return (
        <div className="tool-panel">
            <ConfirmDialog
                isOpen={!!feedback}
                title={feedback?.title || ''}
                message={feedback?.message || ''}
                onConfirm={() => setFeedback(null)}
                isLightMode={isLightMode}
                confirmColor={feedback?.type === 'success' ? '#10b981' : '#ef4444'}
                confirmText={feedback?.type === 'success' ? '确定' : '我知道了'}
            />

            <div className="tool-toolbar">
                <div className="tool-toolbar__title">
                    <h3>Qwen3-TTS 设置</h3>
                    <p>管理 Qwen3-TTS 的音色模式与批量参数。</p>
                </div>
                <div className="segmented-control segmented-control--wrap">
                    {(['clone', 'design', 'preset'] as QwenMode[]).map((item) => (
                        <button
                            key={item}
                            onClick={() => handleModeSwitch(item)}
                            className={`segmented-control__button${mode === item ? ' segmented-control__button--active' : ''}`}
                        >
                            {isActive && activeMode === item && <span className="qwen-tts__live-dot" />}
                            {MODE_META[item].title}
                        </button>
                    ))}
                </div>
            </div>

            <div className="tool-banner">
                <div className="tool-banner__title">
                    {isNarrationMode ? '朗读模式' : '克隆模式'} / {MODE_META[mode].title}
                </div>
                <div className="tool-banner__body">
                    <div>{runtimeSummary}</div>
                    <div>{modeCombinationHint}</div>
                </div>
            </div>

            {switchingNotice(previewLoading)}

            <div className="dense-grid">
                <FieldBlock
                    label="模型档位"
                    hint={TTS_MODEL_PROFILES.qwen.find((option) => option.id === modelProfile)?.description}
                >
                    <select
                        className="field-control"
                        value={modelProfile}
                        onChange={(event) => onModelProfileChange?.(event.target.value)}
                    >
                        {TTS_MODEL_PROFILES.qwen.map((option) => (
                            <option key={option.id} value={option.id}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </FieldBlock>

                <FieldBlock
                    label="单段最大长度"
                    hint="控制单段生成长度上限。"
                >
                    <input
                        className="field-control"
                        type="number"
                        min={512}
                        value={maxNewTokens}
                        onChange={(event) => setMaxNewTokens(Math.max(1, parseInt(event.target.value, 10) || 2048))}
                    />
                </FieldBlock>

                <FieldBlock
                    label="目标语言"
                    hint="明确指定发音语言，能减少多音字和跨语种文本的歧义。"
                >
                    <select
                        className="field-control"
                        value={language}
                        onChange={(event) => setLanguage(event.target.value)}
                    >
                        {LANGUAGE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </FieldBlock>

                <FieldBlock
                    label="批量并发"
                    hint={mode === 'clone' && !isNarrationMode
                        ? '逐句克隆模式建议使用较低并发。'
                        : '当前模式可采用常规并发。'}
                >
                    <input
                        className="field-control"
                        type="number"
                        min={1}
                        max={50}
                        value={currentConcurrency}
                        onChange={(event) => setCurrentConcurrency(Math.max(1, parseInt(event.target.value, 10) || 1))}
                    />
                </FieldBlock>
            </div>

            <div className="config-stack">
                {mode === 'clone' && (
                    <div className="config-section">
                        <div className="config-section__head">
                            <div>
                                <h3>参考音色</h3>
                                <p>{isNarrationMode
                                    ? '用于指定整片统一参考音。未设置时将自动提取。'
                                    : '未设置时将参考原片语音特征。'}</p>
                            </div>
                        </div>

                        <div className="readonly-input-row">
                            <div className="readonly-input-row__field">
                                <input
                                    className="readonly-input"
                                    type="text"
                                    value={refAudioPath}
                                    readOnly
                                    placeholder={isNarrationMode ? '未设置，正式生成时自动提取参考音' : '未设置，正式生成时逐句参考原片'}
                                />
                                {refAudioPath && (
                                    <button className="inline-clear" onClick={clearReferenceAudio} title="清除参考音频">
                                        ×
                                    </button>
                                )}
                            </div>
                            <button onClick={handleSelectFile} className="secondary-button secondary-button--primary">
                                选择音频
                            </button>
                        </div>

                        <div>
                            {refAudioPath
                                ? <span className="status-inline status-inline--warn">已设置固定参考音频</span>
                                : <span className="status-inline">{isNarrationMode ? '自动提取参考音' : '按片段参考原视频'}</span>}
                        </div>

                        <FieldBlock
                            label="参考音频文本"
                            hint="填写参考原文可提升音色一致性。"
                        >
                            <textarea
                                className="tool-textarea"
                                value={refText}
                                onChange={(event) => setRefText(event.target.value)}
                                placeholder={isNarrationMode ? '请输入固定参考音频中的原文...' : '请输入指定参考音频中的原文...'}
                            />
                        </FieldBlock>
                    </div>
                )}

                {mode === 'design' && (
                    <div className="config-section">
                        <div className="config-section__head">
                            <div>
                                <h3>音色设计</h3>
                                <p>{isNarrationMode
                                    ? '通过文字描述创建统一旁白音色。'
                                    : '适用于统一讲解与说明类音轨。'}</p>
                            </div>
                        </div>

                        {hasDesignRef && (
                            <div className="tool-banner">
                                <div className="tool-banner__title">已锁定设计音色</div>
                                <div className="tool-banner__body">批量配音将复用该音色。</div>
                                <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
                                    <button onClick={handleClearDesign} className="secondary-button secondary-button--danger">
                                        重置锁定
                                    </button>
                                </div>
                            </div>
                        )}

                        <FieldBlock
                            label="音色描述指令"
                            hint={isNarrationMode
                                ? '例如：温和自然的纪录片女声，吐字清晰，语速平稳。'
                                : '例如：沉稳克制的男中音。'}
                        >
                            <textarea
                                className="tool-textarea"
                                value={voiceInstruction}
                                onChange={(event) => setVoiceInstruction(event.target.value)}
                                placeholder={isNarrationMode ? '输入旁白音色描述...' : '输入统一解说音色描述...'}
                            />
                        </FieldBlock>
                    </div>
                )}

                {mode === 'preset' && (
                    <div className="config-section">
                        <div className="config-section__head">
                            <div>
                                <h3>预置角色</h3>
                            <p>选择模型内置音色。</p>
                            </div>
                        </div>

                        <FieldBlock
                            label="预置音色"
                            hint="建议完成试听确认后再投入批量任务。"
                        >
                            <select
                                className="field-control"
                                value={presetVoice}
                                onChange={(event) => setPresetVoice(event.target.value)}
                            >
                                {PRESET_VOICE_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                        </FieldBlock>
                    </div>
                )}

                <div className="config-section">
                    <div className="config-section__head">
                        <div>
                            <h3>试听验证</h3>
                            <p>{MODE_PREVIEW_HINT[mode]}</p>
                        </div>
                    </div>

                    <FieldBlock
                        label="试听文本"
                        hint="建议先使用短句完成试听确认。"
                    >
                        <textarea
                            className="tool-textarea"
                            value={currentPreviewText}
                            onChange={(event) => setPreviewTexts((prev) => ({ ...prev, [mode]: event.target.value }))}
                            placeholder="输入要试听的文本..."
                        />
                    </FieldBlock>

                    <div className="form-actions qwen-tts__preview-actions">
                        <button
                            onClick={previewLoading ? handleStopPreview : handleGeneratePreview}
                            className={`secondary-button${previewLoading ? ' secondary-button--danger' : ' secondary-button--primary'}`}
                        >
                            {previewLoading ? '停止试听' : '生成试听'}
                        </button>
                        <button
                            onClick={handlePlayPreview}
                            disabled={!currentPreviewPath}
                            className="secondary-button"
                        >
                            {isPlaying ? '停止播放' : '播放试听'}
                        </button>
                    </div>

                    {currentPreviewPath ? (
                        <div className="collapsed-note">
                            试听文件: {currentPreviewPath}
                        </div>
                    ) : (
                        <div className="collapsed-note">
                            尚未生成试听音频。
                        </div>
                    )}
                </div>
            </div>

            <div className="collapsed-note qwen-tts__managed-note">
                高级采样参数由系统统一管理。
            </div>

            <div className="form-actions">
                <button
                    onClick={() => {
                        handleSave();
                        onActivate?.();
                    }}
                    disabled={!!(isActive && mode === activeMode)}
                    className="secondary-button secondary-button--primary"
                >
                    {isActive && mode === activeMode ? '已启用' : '启用配置'}
                </button>
                <button onClick={handleSave} className="primary-button">
                    保存配置
                </button>
            </div>
        </div>
    );
}

function switchingNotice(previewLoading: boolean) {
    if (!previewLoading) return null;

    return (
        <div className="tool-banner tool-banner--warn">
            <div className="tool-banner__title">试听生成中</div>
            <div className="tool-banner__body">正在生成试听音频。</div>
        </div>
    );
}

export default QwenTTSConfig;
