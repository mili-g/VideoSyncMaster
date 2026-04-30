import type { AsrProviderPanelProps } from '../types';
import { InfoPanel, NumberField, SelectField } from '../shared';

export default function QwenAsrPanel({
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
                        <h3>Qwen3-ASR 模型设置</h3>
                        <p>管理 Qwen3-ASR 的模型档位与执行参数。</p>
                    </div>
                </div>
                <SelectField
                    label="模型档位"
                    value={profileId}
                    onChange={onProfileChange}
                    options={[
                        { value: 'standard', label: 'Standard / 1.7B' },
                        { value: 'fast', label: 'Fast / 0.6B' }
                    ]}
                    hint={profileDescription}
                />
                <InfoPanel
                    title="引擎定位"
                    body="适用于多语种本地识别与标准字幕生产流程。"
                />
            </section>

            <section className="config-section">
                <div className="config-section__head">
                    <div>
                        <h3>Qwen3-ASR Runtime</h3>
                        <p>配置计算设备、吞吐规模与生成长度上限。</p>
                    </div>
                </div>
                <div className="field-grid">
                    <SelectField
                        label="计算设备"
                        value={runtimeSettings.localAsrDevice}
                        onChange={(value) => updateRuntimeSetting('localAsrDevice', value as typeof runtimeSettings.localAsrDevice)}
                        options={[
                            { value: 'auto', label: 'Auto' },
                            { value: 'cuda', label: 'CUDA' },
                            { value: 'cpu', label: 'CPU' }
                        ]}
                        hint="指定当前识别任务的计算设备。"
                    />
                    <NumberField
                        label="推理批大小"
                        value={runtimeSettings.localAsrMaxInferenceBatchSize}
                        min={1}
                        max={128}
                        step={1}
                        onChange={(value) => updateRuntimeSetting('localAsrMaxInferenceBatchSize', Math.max(1, Number.isFinite(value) ? value : 1))}
                        hint="控制单次推理吞吐规模。"
                    />
                    <NumberField
                        label="最大生成 Token"
                        value={runtimeSettings.localAsrMaxNewTokens}
                        min={32}
                        max={4096}
                        step={32}
                        onChange={(value) => updateRuntimeSetting('localAsrMaxNewTokens', Math.max(32, Number.isFinite(value) ? value : 32))}
                        hint="控制单段生成长度上限。"
                    />
                </div>
            </section>
        </div>
    );
}
