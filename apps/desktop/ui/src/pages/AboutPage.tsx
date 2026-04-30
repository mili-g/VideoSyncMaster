import AboutView from '../components/AboutView';
import PageFrame from '../layout/PageFrame';

export default function AboutPage() {
    return (
        <div className="view-page-shell">
            <PageFrame
                eyebrow="System"
                title="关于"
                description="保留版本信息、能力边界和运行说明，避免和工作流配置混在一起。"
                headerMode="compact"
            >
                <AboutView themeMode="dark" />
            </PageFrame>
        </div>
    );
}
