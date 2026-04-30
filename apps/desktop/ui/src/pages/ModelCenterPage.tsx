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
                description="集中管理本地模型、下载入口和路径状态。业务页面只消费结果，不直接承担模型运维职责。"
                headerMode="hidden"
            >
                <ModelManager themeMode="dark" {...props} />
            </PageFrame>
        </div>
    );
}
