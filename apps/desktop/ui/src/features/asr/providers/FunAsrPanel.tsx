import type { AsrProviderPanelProps } from '../types';
import { NumberField, SelectField } from '../shared';

export default function FunAsrPanel({
    profileId,
    profileDescription,
    onProfileChange,
    runtimeSettings,
    updateRuntimeSetting
}: AsrProviderPanelProps) {
    const isMultilingual = profileId === 'standard';

    return (
        <div className="provider-settings-grid">
            <section className="config-section config-section--wide">
                <div className="config-section__head">
                    <div>
                        <h3>FunASR 运行参数</h3>
                        <p>{isMultilingual ? '默认使用 SenseVoiceSmall 多语言模型。' : '当前使用 paraformer-zh 中文模型组合。'}</p>
                    </div>
                    <div className="status-inline">{isMultilingual ? '多语言' : '中文优先'}</div>
                </div>
                <SelectField
                    label="模型档位"
                    value={profileId}
                    onChange={onProfileChange}
                    options={[
                        { value: 'standard', label: 'Standard / SenseVoiceSmall' },
                        { value: 'zh', label: 'Chinese / paraformer-zh' }
                    ]}
                    hint={profileDescription}
                />
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
                        hint="FunASR 将按官方 AutoModel 方式加载到当前设备。"
                    />
                    <SelectField
                        label="合并 VAD 片段"
                        value={runtimeSettings.funAsrMergeVad ? 'true' : 'false'}
                        onChange={(value) => updateRuntimeSetting('funAsrMergeVad', value === 'true')}
                        options={[
                            { value: 'true', label: '启用' },
                            { value: 'false', label: '禁用' }
                        ]}
                        hint="启用后会将相邻 VAD 片段合并，适合更自然的句级字幕。"
                    />
                    <NumberField
                        label="批处理秒数"
                        value={runtimeSettings.funAsrBatchSizeSeconds}
                        min={1}
                        max={1200}
                        step={10}
                        onChange={(value) => updateRuntimeSetting('funAsrBatchSizeSeconds', Math.max(1, Number.isFinite(value) ? value : 1))}
                        hint="对应 FunASR 官方 generate 的 batch_size_s 参数。"
                    />
                </div>
            </section>
        </div>
    );
}
