import type { AsrProviderPanelProps } from '../types';
import { InfoPanel } from '../shared';

export default function JianyingApiPanel({
}: AsrProviderPanelProps) {
    return (
        <div className="provider-settings-grid">
            <section className="config-section config-section--wide">
                <div className="config-section__head">
                    <div>
                        <h3>剪映 API</h3>
                        <p>当前使用云端默认识别通道。</p>
                    </div>
                    <div className="status-inline">自动识别</div>
                </div>
                <InfoPanel
                    title="语言策略"
                    body="当前通道采用服务端自动识别策略。需要指定语言时，请切换至本地多语种引擎。"
                />
            </section>
        </div>
    );
}
