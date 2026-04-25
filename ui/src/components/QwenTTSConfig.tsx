import React, { useState, useEffect } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { preparePreviewCacheFile } from '../utils/projectPaths';
import type { TtsVoiceMode } from '../utils/runtimeSettings';

interface QwenTTSConfigProps {
    themeMode?: 'light' | 'dark' | 'gradient';
    voiceMode: TtsVoiceMode;
    isActive?: boolean;
    onActivate?: () => void;
    onModeChange?: (mode: 'clone' | 'design' | 'preset') => void;
    batchSize: number;
    setBatchSize: (size: number) => void;
    cloneBatchSize: number;
    setCloneBatchSize: (size: number) => void;
    maxNewTokens: number;
    setMaxNewTokens: (token: number) => void;
}

const QwenTTSConfig: React.FC<QwenTTSConfigProps> = ({ themeMode, voiceMode, isActive, onActivate, onModeChange, batchSize, setBatchSize, cloneBatchSize, setCloneBatchSize, maxNewTokens, setMaxNewTokens }) => {
    const isLightMode = themeMode === 'gradient' || themeMode === 'light';
    const isNarrationMode = voiceMode === 'narration';

    // Modes: 'clone' (Default) | 'design' (Prompt based) | 'preset' (Built-in speakers)
    const [mode, setMode] = useState<'clone' | 'design' | 'preset'>('clone');
    const [activeMode, setActiveMode] = useState<'clone' | 'design' | 'preset' | null>(null);

    // Config
    const [refAudioPath, setRefAudioPath] = useState<string>('');
    // For Clone: Prompt Text acts as transcript of ref audio. 
    // For Design: It implies the instruction.
    // Let's separate them.
    const [voiceInstruction, setVoiceInstruction] = useState<string>(''); // For Design (e.g. "Sweet female")
    const [presetVoice, setPresetVoice] = useState<string>('Vivian'); // For Preset Mode
    const [refText, setRefText] = useState<string>(''); // For Clone (Transcript)
    const [language, setLanguage] = useState<string>('Chinese'); // Target Language

    // Preview States
    const [previewTexts, setPreviewTexts] = useState<Record<'clone' | 'design' | 'preset', string>>({
        clone: '这是一个声音克隆的测试音频。',
        design: '这是一个声音设计的测试音频。',
        preset: '这是一个预置音色的测试音频。'
    });
    const [feedback, setFeedback] = useState<{ title: string; message: string; type: 'success' | 'error' } | null>(null);
    const [previewLoading, setPreviewLoading] = useState<boolean>(false);
    const [generatedPaths, setGeneratedPaths] = useState<Record<'clone' | 'design' | 'preset', string | null>>({
        clone: null,
        design: null,
        preset: null
    });
    const [isPlaying, setIsPlaying] = useState<boolean>(false);
    const [audioObj, setAudioObj] = useState<HTMLAudioElement | null>(null);

    const [hasDesignRef, setHasDesignRef] = useState<boolean>(false);
    const currentCloneBatchSize = isNarrationMode ? batchSize : cloneBatchSize;
    const setCurrentCloneBatchSize = isNarrationMode ? setBatchSize : setCloneBatchSize;
    const modeSummary = isNarrationMode
        ? '当前为朗读模式：全程使用固定声音来源，不跟随原片逐句情绪。'
        : '当前为克隆模式：优先保留原片逐句参考，适合贴近原说话人的表达。';
    const modeCombinationHint = mode === 'clone'
        ? (isNarrationMode
            ? '声音克隆会固定复用同一个参考音色；未上传参考音时，批量任务会自动从原片提取一段全局声音并复用。'
            : '声音克隆会优先逐句参考原片；上传参考音后，更偏向“指定音色 + 原片上下文约束”的效果。')
        : (isNarrationMode
            ? '当前子模式会提供固定声音来源，适合整片统一旁白。'
            : '当前子模式仍会输出稳定音色，但不会像“声音克隆”那样逐句贴近原片情绪。');

    // Load config
    useEffect(() => {
        const storedMode = localStorage.getItem('qwen_mode');
        if (storedMode) {
            const m = storedMode as any;
            setMode(m);
            setActiveMode(m);
            if (onModeChange) onModeChange(m);
        }

        const storedRef = localStorage.getItem('qwen_ref_audio_path');
        if (storedRef) setRefAudioPath(storedRef);

        const storedRefText = localStorage.getItem('qwen_ref_text');
        if (storedRefText) setRefText(storedRefText);

        const storedInstruct = localStorage.getItem('qwen_voice_instruction');
        if (storedInstruct) setVoiceInstruction(storedInstruct);

        const storedPreset = localStorage.getItem('qwen_preset_voice');
        if (storedPreset) setPresetVoice(storedPreset);

        const storedLang = localStorage.getItem('qwen_language');
        if (storedLang && storedLang !== 'Auto') {
            setLanguage(storedLang);
        } else if (storedLang === 'Auto') {
            // Migration: Auto is deprecated, default to Chinese
            setLanguage('Chinese');
            localStorage.setItem('qwen_language', 'Chinese'); // Auto-fix storage immediately
        }

        // Load mode-specific audio paths
        const modes: ('clone' | 'design' | 'preset')[] = ['clone', 'design', 'preset'];
        const paths = { ...generatedPaths };
        const texts = { ...previewTexts };

        modes.forEach(m => {
            const p = localStorage.getItem(`qwen_preview_path_${m}`);
            if (p) paths[m] = p;
            const t = localStorage.getItem(`qwen_preview_text_${m}`);
            if (t) texts[m] = t;
        });
        setGeneratedPaths(paths);
        setPreviewTexts(texts);

        setHasDesignRef(!!localStorage.getItem('qwen_design_ref_audio'));
    }, []);

    const handleSave = () => {
        localStorage.setItem('qwen_mode', mode);
        setActiveMode(mode);
        localStorage.setItem('qwen_ref_audio_path', refAudioPath);
        localStorage.setItem('qwen_ref_text', refText);
        localStorage.setItem('qwen_voice_instruction', voiceInstruction);
        localStorage.setItem('qwen_preset_voice', presetVoice);
        localStorage.setItem('qwen_language', language);

        setFeedback({ title: '保存成功', message: 'Qwen3 配置已保存！', type: 'success' });
    };

    const handleGeneratePreview = async () => {
        const currentText = previewTexts[mode];
        if (!currentText) return;

        if (mode === 'clone' && !refAudioPath) {
            setFeedback({
                title: '缺少参考音频',
                message: isNarrationMode
                    ? '当前是朗读模式的试听。预览不会自动截取原片默认参考音，请先上传一段固定参考音频。'
                    : '当前是克隆模式的试听。预览不会直接读取原视频片段，请先上传一段参考音频后再试听。',
                type: 'error'
            });
            return;
        }

        // Stop any current playback
        if (isPlaying && audioObj) {
            audioObj.pause();
            setIsPlaying(false);
        }

        setPreviewLoading(true);
        // Reset only current mode's path
        setGeneratedPaths(prev => ({ ...prev, [mode]: null }));

        try {
            const { outputPath } = await preparePreviewCacheFile(`preview_qwen_${mode}.wav`);

            const args = [
                '--action', 'test_tts',
                '--input', currentText,
                '--output', outputPath,
                '--json',
                '--tts_service', 'qwen',
                '--qwen_mode', mode,
                '--lang', language
            ];

            if (mode === 'clone' && refAudioPath) {
                args.push('--ref', refAudioPath);
                if (refText) {
                    args.push('--qwen_ref_text', refText);
                }
            }
            if (mode === 'design' && voiceInstruction) {
                args.push('--voice_instruct', voiceInstruction);
            }
            if (mode === 'preset') {
                args.push('--preset_voice', presetVoice);
            }

            const result = await window.api.runBackend(args);

            if (result && result.success) {
                setGeneratedPaths(prev => ({ ...prev, [mode]: outputPath }));
                localStorage.setItem(`qwen_preview_path_${mode}`, outputPath);
                localStorage.setItem(`qwen_preview_text_${mode}`, currentText);

                if (mode === 'design') {
                    localStorage.setItem('qwen_design_ref_audio', outputPath);
                    localStorage.setItem('qwen_design_ref_text', currentText);
                    setHasDesignRef(true);
                }
            } else {
                setFeedback({ title: '合成失败', message: result?.error || '未知错误', type: 'error' });
            }

        } catch (e: any) {
            console.error(e);
            setFeedback({ title: '合成错误', message: e.message, type: 'error' });
        } finally {
            setPreviewLoading(false);
        }
    };

    const handlePlayPreview = () => {
        const currentPath = generatedPaths[mode];
        if (!currentPath) return;

        if (isPlaying && audioObj) {
            audioObj.pause();
            audioObj.currentTime = 0;
            setIsPlaying(false);
            return;
        }

        const audio = new Audio(`file:///${currentPath.replace(/\\/g, '/')}?t=${Date.now()}`);
        setAudioObj(audio);
        setIsPlaying(true);

        audio.play().catch(e => {
            console.error("Play error:", e);
            setIsPlaying(false);
        });

        audio.onended = () => {
            setIsPlaying(false);
        };
    };

    // Cleanup audio on unmount
    useEffect(() => {
        return () => {
            if (audioObj) {
                audioObj.pause();
                audioObj.currentTime = 0;
            }
        };
    }, [audioObj]);

    const handleClearDesign = () => {
        localStorage.removeItem('qwen_design_ref_audio');
        localStorage.removeItem('qwen_design_ref_text');
        localStorage.removeItem('qwen_preview_path_design');
        setHasDesignRef(false);
        setGeneratedPaths(prev => ({ ...prev, design: null }));
    };

    const handleSelectFile = async () => {
        try {
            const result = await window.api.openFileDialog({
                filters: [{ name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'm4a'] }]
            });
            if (result && !result.canceled && result.filePaths.length > 0) {
                setRefAudioPath(result.filePaths[0]);
            }
        } catch (e) {
            console.error(e);
        }
    };

    const handleStopPreview = async () => {
        try {
            await window.api.killBackend();
            setPreviewLoading(false);
            setFeedback({ title: '已停止', message: '预览生成已停止。', type: 'error' });
        } catch (e) {
            console.error("Failed to stop:", e);
        }
    };

    return (
        <div style={{ padding: '0px', color: isLightMode ? '#333' : '#fff' }}>
            <ConfirmDialog
                isOpen={!!feedback}
                title={feedback?.title || ''}
                message={feedback?.message || ''}
                onConfirm={() => setFeedback(null)}
                isLightMode={isLightMode}
                confirmColor={feedback?.type === 'success' ? '#10b981' : '#ef4444'}
                confirmText={feedback?.type === 'success' ? '好' : '我知道了'}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <h3 style={{ margin: 0, color: isLightMode ? '#000' : '#fff' }}>Qwen3-TTS 设置</h3>
                <div style={{ background: isLightMode ? '#ddd' : '#444', borderRadius: '8px', padding: '2px', display: 'flex' }}>
                    <button onClick={() => { setMode('clone'); if (onModeChange) onModeChange('clone'); }} style={{
                        background: mode === 'clone' ? '#6366f1' : 'transparent',
                        color: mode === 'clone' ? '#fff' : (isLightMode ? '#333' : '#aaa'),
                        border: 'none', borderRadius: '6px', padding: '4px 12px', cursor: 'pointer', fontWeight: 'bold',
                        display: 'flex', alignItems: 'center', gap: '4px'
                    }}>
                        {isActive && activeMode === 'clone' && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 4px #22c55e' }}></span>}
                        声音克隆
                    </button>
                    <button onClick={() => { setMode('design'); if (onModeChange) onModeChange('design'); }} style={{
                        background: mode === 'design' ? '#6366f1' : 'transparent',
                        color: mode === 'design' ? '#fff' : (isLightMode ? '#333' : '#aaa'),
                        border: 'none', borderRadius: '6px', padding: '4px 12px', cursor: 'pointer', fontWeight: 'bold',
                        display: 'flex', alignItems: 'center', gap: '4px'
                    }}>
                        {isActive && activeMode === 'design' && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 4px #22c55e' }}></span>}
                        声音设计
                    </button>
                    <button onClick={() => { setMode('preset'); if (onModeChange) onModeChange('preset'); }} style={{
                        background: mode === 'preset' ? '#6366f1' : 'transparent',
                        color: mode === 'preset' ? '#fff' : (isLightMode ? '#333' : '#aaa'),
                        border: 'none', borderRadius: '6px', padding: '4px 12px', cursor: 'pointer', fontWeight: 'bold',
                        display: 'flex', alignItems: 'center', gap: '4px'
                    }}>
                        {isActive && activeMode === 'preset' && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 4px #22c55e' }}></span>}
                        预置音色
                    </button>
                </div>
            </div>

            <div style={{
                marginBottom: '20px',
                padding: '12px 14px',
                borderRadius: '8px',
                background: isLightMode ? 'rgba(99, 102, 241, 0.08)' : 'rgba(99, 102, 241, 0.16)',
                border: `1px solid ${isLightMode ? '#c7d2fe' : '#4f46e5'}`
            }}>
                <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
                    {isNarrationMode ? '朗读模式' : '克隆模式'} + {mode === 'clone' ? '声音克隆' : mode === 'design' ? '声音设计' : '预置音色'}
                </div>
                <div style={{ fontSize: '0.9em', color: isLightMode ? '#4b5563' : '#d1d5db', lineHeight: 1.5 }}>
                    <div>{modeSummary}</div>
                    <div>{modeCombinationHint}</div>
                </div>
            </div>

            <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>基础参数 (Basic Parameters)</label>
                <div style={{ padding: '15px', background: isLightMode ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)', borderRadius: '8px', border: '1px solid ' + (isLightMode ? '#ddd' : '#444') }}>
                    <div style={{ marginBottom: '15px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>单次生成最大长度 (Max Tokens)</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <input
                                type="number"
                                min="512"
                                value={maxNewTokens}
                                onChange={(e) => setMaxNewTokens(Math.max(1, parseInt(e.target.value) || 2048))}
                                className="input-field"
                                style={{
                                    width: '80px',
                                    padding: '4px 8px',
                                    background: isLightMode ? '#fff' : '#333',
                                    color: isLightMode ? '#000' : '#fff',
                                    borderColor: isLightMode ? '#ccc' : '#555',
                                    textAlign: 'center',
                                    fontWeight: 'bold'
                                }}
                            />
                            <span style={{ fontSize: '0.8em', color: isLightMode ? '#666' : '#aaa' }}>Tokens (推荐 2048-4096)。此参数影响单段配音的最大时长。</span>
                        </div>
                    </div>
                </div>
            </div>

            {mode === 'preset' ? (
                <>


                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>选择预置角色 (Preset Voice)</label>
                        <p style={{ fontSize: '0.9em', color: isLightMode ? '#666' : '#aaa', marginBottom: '5px' }}>
                            使用模型内置固定音色。更适合统一旁白；若需要贴近原片逐句语气，请切回“声音克隆”。
                        </p>
                        <select
                            value={presetVoice}
                            onChange={(e) => setPresetVoice(e.target.value)}
                            className="input-field"
                            style={{
                                width: '100%',
                                padding: '8px',
                                background: isLightMode ? '#fff' : '#333',
                                color: isLightMode ? '#000' : '#fff',
                                borderColor: isLightMode ? '#ccc' : '#555'
                            }}
                        >
                            <option value="Vivian">Vivian - 推荐中文</option>
                            <option value="Serena">Serena - 推荐中文</option>
                            <option value="Uncle_Fu">Uncle_Fu - 傅大爷, 推荐中文</option>
                            <option value="Dylan">Dylan - 推荐英文</option>
                            <option value="Eric">Eric - 推荐英文</option>
                            <option value="Ryan">Ryan - 推荐英文</option>
                            <option value="Aiden">Aiden - 推荐英文</option>
                            <option value="Ono_Anna">Ono_Anna - 推荐日文</option>
                            <option value="Sohee">Sohee - 推荐韩文</option>
                        </select>
                    </div>

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>并发设置 (Concurrency)</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{ fontSize: '0.9em', color: isLightMode ? '#666' : '#aaa' }}>批量生成时的并发数 (Batch Size):</span>
                            <input
                                type="number"
                                min="1"
                                max="50"
                                value={batchSize}
                                onChange={(e) => setBatchSize(Math.max(1, parseInt(e.target.value) || 1))}
                                className="input-field"
                                style={{
                                    width: '60px',
                                    padding: '4px 8px',
                                    background: isLightMode ? '#fff' : '#333',
                                    color: isLightMode ? '#000' : '#fff',
                                    borderColor: isLightMode ? '#ccc' : '#555',
                                    textAlign: 'center',
                                    fontWeight: 'bold'
                                }}
                            />
                        </div>
                        <p style={{ fontSize: '0.8em', color: isLightMode ? '#666' : '#aaa', marginTop: '5px' }}>
                            预置音色使用固定声音来源，适合直接走统一并发。
                        </p>
                    </div>
                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>预览测试 (Preview)</label>
                        <p style={{ fontSize: '0.9em', color: isLightMode ? '#666' : '#aaa', marginBottom: '5px' }}>
                            试听固定预置音色的朗读效果。
                        </p>
                        <div style={{ display: 'flex', gap: '10px' }}>
                            <textarea
                                value={previewTexts.preset}
                                onChange={(e) => setPreviewTexts(prev => ({ ...prev, preset: e.target.value }))}
                                placeholder="输入要试听的文本..."
                                className="input-field"
                                style={{
                                    flex: 1,
                                    height: '50px',
                                    resize: 'none',
                                    cursor: 'text',
                                    caretColor: isLightMode ? '#000' : '#fff'
                                }}
                            />
                            <button
                                onClick={previewLoading ? handleStopPreview : handleGeneratePreview}
                                style={{
                                    padding: '0 15px',
                                    background: previewLoading ? '#ef4444' : '#8b5cf6',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    fontWeight: 'bold',
                                    marginRight: '5px'
                                }}
                            >
                                {previewLoading ? '⏹ 停止' : '🛠️ 合成'}
                            </button>
                            <button
                                onClick={handlePlayPreview}
                                disabled={!generatedPaths.preset}
                                style={{
                                    padding: '0 15px',
                                    background: !generatedPaths.preset ? '#555' : (isPlaying ? '#e11d48' : '#10b981'),
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: !generatedPaths.preset ? 'not-allowed' : 'pointer',
                                    fontWeight: 'bold',
                                    minWidth: '80px',
                                    transition: 'background 0.2s'
                                }}
                            >
                                {isPlaying ? '⏹ 停止' : '▶ 播放'}
                            </button>
                        </div>
                    </div>
                </>
            ) : mode === 'clone' ? (
                <>

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>参考音频</label>
                        <p style={{ fontSize: '0.9em', color: isLightMode ? '#666' : '#aaa', marginBottom: '5px' }}>
                            {isNarrationMode
                                ? '朗读模式下，这里用于指定整片统一参考音。留空时，批量任务会自动从原片挑选一段默认声音并全程复用。'
                                : '克隆模式下，留空时会在正式生成时逐句参考原片；只有想固定使用某个指定音色时才上传。'}
                        </p>
                        <div style={{ display: 'flex', gap: '10px' }}>
                            <input
                                type="text"
                                value={refAudioPath}
                                onChange={(e) => setRefAudioPath(e.target.value)}
                                placeholder="自动截取 (留空)"
                                className="input-field"
                                style={{
                                    flex: 1,
                                    cursor: 'text',
                                    caretColor: isLightMode ? '#000' : '#fff'
                                }}
                            />
                            <button onClick={handleSelectFile} style={{ padding: '8px 16px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                                📂
                            </button>
                        </div>
                        <p style={{ fontSize: '0.8em', color: isLightMode ? '#666' : '#aaa', marginTop: '5px' }}>
                            {refAudioPath
                                ? '✅ 已选择固定参考音频'
                                : isNarrationMode
                                    ? 'ℹ️ 正式生成时将自动提取一个全局参考音并在全片复用'
                                    : 'ℹ️ 正式生成时将按片段逐句参考原视频声音'}
                        </p>
                    </div>

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>参考音频文本 (Reference Text)</label>
                        <p style={{ fontSize: '0.9em', color: isLightMode ? '#666' : '#aaa', marginBottom: '5px' }}>
                            填写所上传参考音频对应的原文可提升音色一致性。留空时仅做音色参考，相似度通常会下降。
                        </p>
                        <textarea
                            value={refText}
                            onChange={(e) => setRefText(e.target.value)}
                            placeholder={isNarrationMode ? '请输入固定参考音频中的原文...' : '请输入指定参考音频中的原文...'}
                            className="input-field"
                            style={{
                                width: '100%',
                                height: '60px', // Slightly taller for transcript
                                resize: 'none',
                                cursor: 'text',
                                caretColor: isLightMode ? '#000' : '#fff',
                                boxSizing: 'border-box'
                            }}
                        />
                    </div>

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>并发设置 (Concurrency)</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{ fontSize: '0.9em', color: isLightMode ? '#666' : '#aaa' }}>批量生成时的并发数 (Batch Size):</span>
                            <input
                                type="number"
                                min="1"
                                max="50"
                                value={currentCloneBatchSize}
                                onChange={(e) => setCurrentCloneBatchSize(Math.max(1, parseInt(e.target.value) || 1))}
                                className="input-field"
                                style={{
                                    width: '60px',
                                    padding: '4px 8px',
                                    background: isLightMode ? '#fff' : '#333',
                                    color: isLightMode ? '#000' : '#fff',
                                    borderColor: isLightMode ? '#ccc' : '#555',
                                    textAlign: 'center',
                                    fontWeight: 'bold'
                                }}
                            />
                        </div>
                        <p style={{ fontSize: '0.8em', color: isLightMode ? '#666' : '#aaa', marginTop: '5px' }}>
                            {isNarrationMode
                                ? '朗读模式下会按固定声音来源处理，因此这里使用常规并发。'
                                : '克隆模式下逐句参考原片成本更高，建议保守设置并发。'}
                        </p>
                    </div>

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>预览测试 (Preview)</label>
                        <p style={{ fontSize: '0.9em', color: isLightMode ? '#666' : '#aaa', marginBottom: '5px' }}>
                            {isNarrationMode
                                ? '预览阶段无法自动截取原片默认参考音；如需试听固定声音，请先上传一段参考音频。'
                                : '预览阶段不读取原视频片段；如需试听克隆效果，请先上传一段参考音频。'}
                        </p>
                        <div style={{ display: 'flex', gap: '10px' }}>
                            <textarea
                                value={previewTexts.clone}
                                onChange={(e) => setPreviewTexts(prev => ({ ...prev, clone: e.target.value }))}
                                placeholder="输入要试听的文本..."
                                className="input-field"
                                style={{
                                    flex: 1,
                                    height: '50px',
                                    resize: 'none',
                                    cursor: 'text',
                                    caretColor: isLightMode ? '#000' : '#fff'
                                }}
                            />
                            <button
                                onClick={previewLoading ? handleStopPreview : handleGeneratePreview}
                                style={{
                                    padding: '0 15px',
                                    background: previewLoading ? '#ef4444' : '#8b5cf6',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    fontWeight: 'bold',
                                    marginRight: '5px'
                                }}
                            >
                                {previewLoading ? '⏹ 停止' : '🛠️ 合成'}
                            </button>
                            <button
                                onClick={handlePlayPreview}
                                disabled={!generatedPaths.clone}
                                style={{
                                    padding: '0 15px',
                                    background: !generatedPaths.clone ? '#555' : (isPlaying ? '#e11d48' : '#10b981'),
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: !generatedPaths.clone ? 'not-allowed' : 'pointer',
                                    fontWeight: 'bold',
                                    minWidth: '80px',
                                    transition: 'background 0.2s'
                                }}
                            >
                                {isPlaying ? '⏹ 停止' : '▶ 播放'}
                            </button>
                        </div>
                    </div>
                </>
            ) : ( // This is for mode === 'design'
                <>

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>音色描述指令 (Voice Instruction)</label>
                        {hasDesignRef && (
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px',
                                background: isLightMode ? '#dcfce7' : '#064e3b',
                                padding: '8px 12px',
                                borderRadius: '6px',
                                marginBottom: '10px',
                                border: '1px solid #22c55e'
                            }}>
                                <span style={{ color: isLightMode ? '#166534' : '#4ade80', fontSize: '0.9em', fontWeight: 'bold' }}>
                                    ✅ 已锁定设计音色 (批量配音将保持一致)
                                </span>
                                <button
                                    onClick={handleClearDesign}
                                    style={{
                                        background: '#ef4444',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        padding: '2px 8px',
                                        fontSize: '0.8em',
                                        cursor: 'pointer'
                                    }}
                                >
                                    重置
                                </button>
                            </div>
                        )}
                        <p style={{ fontSize: '0.9em', color: isLightMode ? '#666' : '#aaa', marginBottom: '5px' }}>
                            {isNarrationMode
                                ? '用文字设计一个固定朗读音色，例如“温和的纪录片女声”或“沉稳的新闻男声”。'
                                : '用文字设计一个稳定音色来源。它更适合统一旁白，不会像“声音克隆”那样逐句贴近原片语气。'}
                        </p>
                        <textarea
                            value={voiceInstruction}
                            onChange={(e) => setVoiceInstruction(e.target.value)}
                            placeholder={isNarrationMode ? '例如：一个清晰自然的纪录片旁白女声，语速平稳...' : '例如：一个沉稳克制的男中音，适合统一解说...'}
                            className="input-field"
                            style={{
                                width: '100%',
                                height: '80px',
                                resize: 'none',
                                cursor: 'text',
                                caretColor: isLightMode ? '#000' : '#fff',
                                boxSizing: 'border-box'
                            }}
                        />
                    </div>

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>预览测试 (Preview)</label>
                        <p style={{ fontSize: '0.9em', color: isLightMode ? '#666' : '#aaa', marginBottom: '5px' }}>
                            先试听并锁定设计音色，批量配音时会复用这个固定声音。
                        </p>
                        <div style={{ display: 'flex', gap: '10px' }}>
                            <textarea
                                value={previewTexts.design}
                                onChange={(e) => setPreviewTexts(prev => ({ ...prev, design: e.target.value }))}
                                placeholder="输入要试听的文本..."
                                className="input-field"
                                style={{
                                    flex: 1,
                                    height: '50px',
                                    resize: 'none',
                                    cursor: 'text',
                                    caretColor: isLightMode ? '#000' : '#fff'
                                }}
                            />
                            <button
                                onClick={previewLoading ? handleStopPreview : handleGeneratePreview}
                                style={{
                                    padding: '0 15px',
                                    background: previewLoading ? '#ef4444' : '#8b5cf6',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    fontWeight: 'bold',
                                    marginRight: '5px'
                                }}
                            >
                                {previewLoading ? '⏹ 停止' : '🛠️ 合成'}
                            </button>
                            <button
                                onClick={handlePlayPreview}
                                disabled={!generatedPaths.design}
                                style={{
                                    padding: '0 15px',
                                    background: !generatedPaths.design ? '#555' : (isPlaying ? '#e11d48' : '#10b981'),
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: !generatedPaths.design ? 'not-allowed' : 'pointer',
                                    fontWeight: 'bold',
                                    minWidth: '80px',
                                    transition: 'background 0.2s'
                                }}
                            >
                                {isPlaying ? '⏹ 停止' : '▶ 播放'}
                            </button>
                        </div>
                    </div>
                </>
            )}

            {mode === 'design' && (
                <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>并发设置 (Concurrency)</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '0.9em', color: isLightMode ? '#666' : '#aaa' }}>批量生成时的并发数 (Batch Size):</span>
                        <input
                            type="number"
                            min="1"
                            max="50"
                            value={batchSize}
                            onChange={(e) => setBatchSize(Math.max(1, parseInt(e.target.value) || 1))}
                            className="input-field"
                            style={{
                                width: '60px',
                                padding: '4px 8px',
                                background: isLightMode ? '#fff' : '#333',
                                color: isLightMode ? '#000' : '#fff',
                                borderColor: isLightMode ? '#ccc' : '#555',
                                textAlign: 'center',
                                fontWeight: 'bold'
                            }}
                            />
                        </div>
                        <p style={{ fontSize: '0.8em', color: isLightMode ? '#666' : '#aaa', marginTop: '5px' }}>
                            声音设计会锁定为统一音色，批量任务使用常规并发即可。
                        </p>
                </div>
            )}

            <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>目标语言 (Target Language)</label>
                <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="input-field"
                    style={{
                        width: '100%',
                        padding: '8px',
                        background: isLightMode ? '#fff' : '#333',
                        color: isLightMode ? '#000' : '#fff',
                        borderColor: isLightMode ? '#ccc' : '#555'
                    }}
                >
                    <option value="Chinese">Chinese - 中文</option>
                    <option value="English">English - 英文</option>
                    <option value="Japanese">Japanese - 日文</option>
                    <option value="Korean">Korean - 韩文</option>
                    <option value="German">German - 德文</option>
                    <option value="French">French - 法文</option>
                    <option value="Spanish">Spanish - 西班牙文</option>
                    <option value="Russian">Russian - 俄文</option>
                    <option value="Portuguese">Portuguese - 葡萄牙文</option>
                    <option value="Italian">Italian - 意大利文</option>
                </select>
                <p style={{ fontSize: '0.8em', color: isLightMode ? '#666' : '#aaa', marginTop: '5px' }}>
                    指定生成语音的语言，有助于解决多音字或汉字的发音歧义。
                </p>
            </div>

            <div style={{ borderTop: isLightMode ? '1px solid #eee' : '1px solid #444', margin: '20px 0' }}></div>

            {/* Removed Advanced Parameters (Temperature, Top P, etc.) as requested to prevent model interference */}
            <p style={{ fontSize: '0.9em', color: isLightMode ? '#666' : '#aaa', fontStyle: 'italic', textAlign: 'center' }}>
                (高级参数已由系统自动托管以确保最佳生成稳定性)
            </p>

            <div style={{ textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                <button
                    onClick={() => {
                        handleSave();
                        if (onActivate) onActivate();
                    }}
                    disabled={isActive && mode === activeMode}
                    style={{
                        padding: '10px 24px',
                        background: (isActive && mode === activeMode) ? '#4b5563' : '#3b82f6',
                        color: 'white',
                        borderRadius: '4px',
                        cursor: (isActive && mode === activeMode) ? 'default' : 'pointer',
                        fontWeight: 'bold',
                        opacity: (isActive && mode === activeMode) ? 1 : 0.8,
                        boxShadow: (isActive && mode === activeMode) ? '0 0 10px #22c55e' : 'none',
                        border: (isActive && mode === activeMode) ? '2px solid #22c55e' : 'none'
                    }}
                >
                    {(isActive && mode === activeMode) ? '✅ 当前已激活' : '⚡ 启用此配置'}
                </button>
                <button
                    onClick={handleSave}
                    style={{
                        padding: '10px 24px',
                        background: '#10b981',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontWeight: 'bold'
                    }}
                >
                    💾 保存 TTS 配置
                </button>
            </div>
        </div>
    );
};

export default QwenTTSConfig;
