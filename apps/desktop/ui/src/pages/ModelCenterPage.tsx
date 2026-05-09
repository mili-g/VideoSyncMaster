import ModelManager from '../components/ModelManager';
import PageFrame from '../layout/PageFrame';

interface ModelCenterPageProps {
    onStatusChange?: (status: string) => void;
    onFeedback?: (feedback: { title: string; message: string; type: 'success' | 'error' }) => void;
}

export default function ModelCenterPage(props: ModelCenterPageProps) {
    return (
        <div className="view-page-shell">
            <PageFrame
                eyebrow="Models"
                title="模型中心"
                description=""
                headerMode="hidden"
            >
                <ModelManager themeMode="dark" {...props} />
            </PageFrame>
        </div>
    );
}
