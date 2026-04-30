import type { AsrProviderPanelProps } from '../types';
import { NumberField, SelectField } from '../shared';

export default function VibeVoiceAsrPanel({
    runtimeSettings,
    updateRuntimeSetting
}: AsrProviderPanelProps) {
    return (
        <div className="provider-settings-grid">
            <section className="config-section config-section--wide">
                <div className="config-section__head">
                    <div>
                        <h3>VibeVoice-ASR 运行参数</h3>
                        <p>当前固定使用 HF 档位。</p>
                    </div>
                    <div className="status-inline">长音频</div>
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
                    />
                    <NumberField
                        label="推理批大小"
                        value={runtimeSettings.localAsrMaxInferenceBatchSize}
                        min={1}
                        max={128}
                        step={1}
                        onChange={(value) => updateRuntimeSetting('localAsrMaxInferenceBatchSize', Math.max(1, Number.isFinite(value) ? value : 1))}
                    />
                    <NumberField
                        label="最大生成 Token"
                        value={Math.min(32, runtimeSettings.localAsrMaxNewTokens)}
                        min={32}
                        max={32}
                        step={32}
                        onChange={() => updateRuntimeSetting('localAsrMaxNewTokens', 32)}
                    />
                </div>
            </section>
        </div>
    );
}
