import TranslationConfig from '../components/TranslationConfig';
import PageFrame from '../layout/PageFrame';

export default function TranslationSettingsPage() {
    return (
        <div className="view-page-shell">
            <PageFrame
                eyebrow="Translation"
                title="翻译配置"
                description="单独维护翻译 API、模型与回退策略，避免与识别、配音配置相互缠绕。"
                headerMode="hidden"
            >
                <TranslationConfig />
            </PageFrame>
        </div>
    );
}
