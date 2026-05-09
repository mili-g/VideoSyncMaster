import AboutView from '../components/AboutView';
import PageFrame from '../layout/PageFrame';

export default function AboutPage() {
    return (
        <div className="view-page-shell">
            <PageFrame
                eyebrow="System"
                title="关于"
                description=""
                headerMode="compact"
            >
                <AboutView themeMode="dark" />
            </PageFrame>
        </div>
    );
}
