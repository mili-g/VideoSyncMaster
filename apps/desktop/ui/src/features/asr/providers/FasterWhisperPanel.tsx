import type { AsrProviderPanelProps } from '../types';
import { NumberField, SelectField, InfoPanel } from '../shared';

export default function FasterWhisperPanel({
    profileId,
    profileDescription,
    onProfileChange,
    runtimeSettings,
    updateRuntimeSetting
}: AsrProviderPanelProps) {
    return (
        <div className="provider-settings-grid">
            <section className="config-section">
                <div className="config-section__head">
                    <div>
                        <h3>模型设置</h3>
                        <p>配置 faster-whisper 的模型档位与语音活动检测策略。</p>
                    </div>
                </div>
                <SelectField
                    label="模型档位"
                    value={profileId}
                    onChange={onProfileChange}
                    options={[
                        { value: 'quality', label: 'Quality / large-v3' },
                        { value: 'balanced', label: 'Balanced / large-v3-turbo' }
                    ]}
                    hint={profileDescription}
                />
                <InfoPanel
                    title="引擎定位"
                    body="适用于常规视频字幕生产，是离线识别的标准交付方案。"
                />
            </section>

            <section className="config-section">
                <div className="config-section__head">
                    <div>
                        <h3>VAD 与断句</h3>
                        <p>控制语音检测与断句边界，优化字幕切分稳定性。</p>
                    </div>
                </div>
                <SelectField
                    label="启用 VAD 过滤"
                    value={runtimeSettings.fasterWhisperVadFilter ? 'true' : 'false'}
                    onChange={(value) => updateRuntimeSetting('fasterWhisperVadFilter', value === 'true')}
                    options={[
                        { value: 'true', label: '启用' },
                        { value: 'false', label: '禁用' }
                    ]}
                    hint="建议保持开启，以获得稳定的断句结果。"
                />
                <div className="field-grid">
                    <NumberField
                        label="VAD 阈值"
                        value={runtimeSettings.fasterWhisperVadThreshold}
                        min={0}
                        max={1}
                        step={0.01}
                        onChange={(value) => updateRuntimeSetting('fasterWhisperVadThreshold', Number.isFinite(value) ? value : 0.4)}
                        hint="越低越保留边缘语音，越高越偏向裁掉弱语音。"
                    />
                    <NumberField
                        label="VAD Onset"
                        value={runtimeSettings.whisperVadOnset}
                        min={0}
                        max={1}
                        step={0.01}
                        onChange={(value) => updateRuntimeSetting('whisperVadOnset', Number.isFinite(value) ? value : 0.7)}
                        hint="控制语音起点敏感度。"
                    />
                    <NumberField
                        label="VAD Offset"
                        value={runtimeSettings.whisperVadOffset}
                        min={0}
                        max={1}
                        step={0.01}
                        onChange={(value) => updateRuntimeSetting('whisperVadOffset', Number.isFinite(value) ? value : 0.7)}
                        hint="控制语音结束判定。"
                    />
                </div>
            </section>
        </div>
    );
}
