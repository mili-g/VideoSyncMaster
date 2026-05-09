import TranslationConfig from '../components/TranslationConfig';
import PageFrame from '../layout/PageFrame';

export default function TranslationSettingsPage() {
    return (
        <div className="view-page-shell">
            <PageFrame
                eyebrow="Translation"
                title="翻译配置"
                description=""
                headerMode="hidden"
            >
                <TranslationConfig />
            </PageFrame>
        </div>
    );
}
