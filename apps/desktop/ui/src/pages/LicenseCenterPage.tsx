import LicenseCenterView from '../components/LicenseCenterView';
import PageFrame from '../layout/PageFrame';

export default function LicenseCenterPage() {
    return (
        <div className="view-page-shell">
            <PageFrame
                eyebrow="Licensing"
                title="授权中心"
                description="管理订阅套餐、设备识别码与授权码激活状态。"
                headerMode="hidden"
            >
                <LicenseCenterView />
            </PageFrame>
        </div>
    );
}
